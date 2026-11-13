import { describe, expect, it, vi } from 'vitest'
import { WithdrawalFlow, type WithdrawalPort, type Snapshot } from './withdrawalFlow'

function setup() {
  let s: Snapshot = { court: '100', pending: '0', ready: null, now: 10, inFlight: '0', height: 100 }
  let valid = true
  const port: WithdrawalPort = {
    key: 'test:pool:alice', valid: () => valid,
    read: vi.fn(async () => ({ ...s })),
    send: vi.fn<WithdrawalPort['send']>(async (method, amount) => {
      if (method === 'request_withdraw') { s = { ...s, court: String(100n - BigInt(amount!)), pending: amount!, ready: 30 }; return { kind: 'request', snapshot: { ...s } } }
      s = { ...s, pending: '0', ready: null }; return { kind: 'paid' }
    }),
  }
  const markers = new Map<string, string>()
  const release = vi.fn()
  const flow = new WithdrawalFlow({ acquire: async () => release, marker: { getItem: k => markers.get(k) ?? null, setItem: (k,v) => { markers.set(k,v) }, removeItem: k => { markers.delete(k) } } })
  return { flow, port, markers, release, set: (v: Partial<Snapshot>) => { s = { ...s, ...v } }, invalidate: () => { valid = false } }
}
describe('bounded one-start withdrawal', () => {
  it('waits for the request receipt height before using balances or chain time', async () => {
    const { flow, port, set } = setup()
    vi.mocked(port.send).mockResolvedValueOnce({ kind: 'request', snapshot: { court: '60', pending: '40', ready: 30, now: 11, inFlight: '0', height: 101 } })
    await flow.start(port, '40')
    set({ height: 100, now: 40, inFlight: '1' }) // older pre-request state, even with a misleading clock
    await flow.tick(); expect(flow.state.phase).toBe('waiting'); expect(port.send).toHaveBeenCalledTimes(1)
    set({ height: 101, court: '60', pending: '40', ready: 30, now: 11, inFlight: '0' })
    await flow.tick(); expect(flow.state.phase).toBe('waiting')
    set({ height: 102, now: 30 }); await flow.tick()
    expect(flow.state.phase).toBe('complete'); expect(port.send).toHaveBeenCalledTimes(2)
  })
  it('advances the freshness floor and still refuses fresh drift', async () => {
    const { flow, port, set } = setup(); await flow.start(port, '40')
    set({ height: 110, now: 20 }); await flow.tick()
    set({ height: 105, pending: '0', now: 40 }); await flow.tick()
    expect(flow.state.phase).toBe('waiting')
    set({ height: 111 }); await flow.tick()
    expect(flow.state.phase).toBe('paused'); expect(port.send).toHaveBeenCalledTimes(1)
  })
  it('one request, authoritative wait, one payout; synchronous double start ignored', async () => {
    const { flow, port, set } = setup()
    const first = flow.start(port, '40'); await flow.start(port, '40'); await first
    expect(port.send).toHaveBeenCalledTimes(1)
    await flow.tick(); expect(port.send).toHaveBeenCalledTimes(1)
    set({ now: 30 }); await Promise.all([flow.tick(), flow.tick()])
    expect(port.send).toHaveBeenCalledTimes(2); expect(flow.state.phase).toBe('complete')
  })
  it.each([{ pending: '41' }, { ready: 31 }, { inFlight: '1' }, { pending: '0' }])('stops observed drift/inflight, never infers payment %j', async delta => {
    const { flow, port, set } = setup(); await flow.start(port, '40'); set({ now: 40, ...delta }); await flow.tick()
    expect(port.send).toHaveBeenCalledTimes(1); expect(flow.state.phase).toBe('paused')
  })
  it('session or identity change disarms', async () => {
    const { flow, port, invalidate, set } = setup(); await flow.start(port, '40'); invalidate(); set({ now: 40 }); await flow.tick()
    expect(port.send).toHaveBeenCalledTimes(1); expect(flow.state.phase).toBe('paused')
  })
  it('existing pending needs explicit finish, no request', async () => {
    const { flow, port, set } = setup(); set({ pending: '40', ready: 30 }); await flow.tick(); expect(port.send).not.toHaveBeenCalled()
    await flow.start(port); expect(port.send).not.toHaveBeenCalled(); set({ now: 30 }); await flow.tick()
    expect(port.send).toHaveBeenCalledExactlyOnceWith('withdraw', undefined, expect.any(Function))
  })
  it.each(['unknown', 'restored'] as const)('terminal %s never retries', async kind => {
    const { flow, port, set } = setup(); await flow.start(port, '40'); vi.mocked(port.send).mockResolvedValue({ kind }); set({ now: 30 }); await flow.tick(); await flow.tick()
    expect(port.send).toHaveBeenCalledTimes(2); expect(flow.state.phase).toBe(kind === 'unknown' ? 'unknown' : 'failed')
  })
  it('ambiguous transport persists a blocking marker; reload has no authority', async () => {
    const { flow, port, markers } = setup(); vi.mocked(port.send).mockRejectedValue(new Error('response lost'))
    await flow.start(port, '40'); await flow.start(port, '40'); await flow.tick()
    expect(flow.state.phase).toBe('unknown'); expect(markers.size).toBe(1); expect(port.send).toHaveBeenCalledTimes(1)
  })
  it.each(['request', 'payout'] as const)('a missing %s response times out to unknown; late success cannot rearm or release ownership', async stage => {
    vi.useFakeTimers()
    try {
      const { flow, port, markers, release, set } = setup(); let resolve!: (r: { kind: 'paid' }) => void
      if (stage === 'payout') { await flow.start(port, '40'); set({ now: 30 }) }
      vi.mocked(port.send).mockReturnValue(new Promise(r => { resolve = r }))
      const pending = stage === 'request' ? flow.start(port, '40') : flow.tick()
      await vi.advanceTimersByTimeAsync(59_999)
      expect(flow.state.phase).toBe(stage === 'request' ? 'requesting' : 'withdrawing')
      await vi.advanceTimersByTimeAsync(1); await pending
      expect(flow.state.phase).toBe('unknown'); expect(markers.size).toBe(1)
      const guard = vi.mocked(port.send).mock.calls.at(-1)![2]
      expect(guard).toThrow()
      resolve({ kind: 'paid' }); await Promise.resolve(); flow.stop(); await flow.start(port, '40'); await flow.tick()
      expect(flow.state.phase).toBe('unknown'); expect(markers.size).toBe(1)
      expect(port.send).toHaveBeenCalledTimes(stage === 'request' ? 1 : 2)
      expect(release).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each(['stop', 'identity'] as const)('late payout after %s invalidation stays unknown with marker and ownership', async reason => {
    const { flow, port, markers, release, set, invalidate } = setup()
    await flow.start(port, '40'); set({ now: 30 })
    let resolve!: (r: { kind: 'paid'; id: string }) => void
    vi.mocked(port.send).mockReturnValue(new Promise(r => { resolve = r }))
    const pending = flow.tick(); await Promise.resolve()
    if (reason === 'stop') flow.stop(); else invalidate()
    resolve({ kind: 'paid', id: 'late-tx' }); await pending
    flow.stop(); await flow.start(port); await flow.tick()
    expect(flow.state.phase).toBe('unknown'); expect(flow.state.id).toBe('late-tx')
    expect(markers.size).toBe(1); expect(release).not.toHaveBeenCalled(); expect(port.send).toHaveBeenCalledTimes(2)
  })
  it('stop during read prevents submission', async () => {
    const { flow, port } = setup(); let resolve!: (s: Snapshot) => void
    vi.mocked(port.read).mockReturnValue(new Promise(r => { resolve = r }))
    const p = flow.start(port, '40'); await Promise.resolve(); flow.stop(); resolve({ court: '100', pending: '0', ready: null, now: 1, inFlight: '0', height: 100 }); await p
    expect(port.send).not.toHaveBeenCalled()
  })
  it('explicit wallet continuation sends only the requested stage, never arms automation', async () => {
    const { flow, port, set } = setup(); await flow.start(port, '40', false); set({ now: 50 }); await flow.tick()
    expect(port.send).toHaveBeenCalledTimes(1); expect(flow.state.phase).toBe('paused')
    await flow.start(port, undefined, false)
    expect(port.send).toHaveBeenCalledTimes(2); expect(flow.state.phase).toBe('complete')
  })
  it('reload with unresolved marker blocks sends, even if pending is zero', async () => {
    const { port, markers } = setup(); markers.set('rugpool:withdrawal-outcome:test:pool:alice', '{"stage":"withdraw"}')
    const flow = new WithdrawalFlow({ acquire: async () => () => {}, marker: { getItem: k => markers.get(k) ?? null, setItem: (k,v) => { markers.set(k,v) }, removeItem: k => { markers.delete(k) } } })
    flow.inspectRecovery(port.key); expect(flow.state.phase).toBe('unknown'); await flow.start(port); await flow.tick(); expect(port.send).not.toHaveBeenCalled()
  })
  it('post-preflight aggregate change is not atomically capped by the existing ABI', async () => {
    const { flow, port, set } = setup(); await flow.start(port, '40'); set({ now: 30 })
    vi.mocked(port.send).mockImplementation(async method => { expect(method).toBe('withdraw'); set({ pending: '55' }); return { kind: 'paid' } })
    await flow.tick(); expect(flow.state.phase).toBe('complete') // same-account full aggregate, not exactly 40
  })
  it('unavailable cross-tab lock fails closed', async () => {
    const { port } = setup(); const flow = new WithdrawalFlow({ acquire: async () => { throw Error('Locks unavailable') }, marker: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
    await flow.start(port, '40'); expect(port.send).not.toHaveBeenCalled(); expect(flow.state.phase).toBe('paused')
  })
})
