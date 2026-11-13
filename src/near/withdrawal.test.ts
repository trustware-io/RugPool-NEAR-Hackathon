import { describe, it, expect, vi } from 'vitest'
import { Near } from './near'
import { withdrawalReceipt, finalizedWithdrawalReceipt } from './withdrawalReceipt'
import { ContractStore } from '../game/contractStore'
import { WithdrawalFlow } from '../state/withdrawalFlow'

describe('withdrawal receipt evidence', () => {
  const receipt = (value: unknown) => ({ final_execution_status: 'FINAL', transaction: { hash: 'tx' }, receipts_outcome: [
    { id: 'call', block_hash: 'block', outcome: { executor_id: 'pool', status: { SuccessReceiptId: 'callback' } } },
    { id: 'callback', outcome: { executor_id: 'pool', status: { SuccessValue: btoa(JSON.stringify(value)) } } },
  ] })
  it.each(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'INCLUDED_FINAL', undefined])('never treats %s as terminal evidence', final_execution_status => {
    for (const value of [true, false]) expect(withdrawalReceipt({ ...receipt(value), final_execution_status }, 'pool', 'withdraw')).toEqual({ kind: 'unknown', id: 'tx' })
    const request = { final_execution_status, transaction: { hash: 'tx' }, receipts_outcome: [{ id: 'call', block_hash: 'block', outcome: { executor_id: 'pool', status: { SuccessValue: '' } } }] }
    expect(withdrawalReceipt(request, 'pool', 'request_withdraw').kind).toBe('unknown')
    expect(withdrawalReceipt({ ...request, receipts_outcome: [{ outcome: { executor_id: 'pool', status: { Failure: 'rejected' } } }] }, 'pool', 'withdraw').kind).toBe('unknown')
  })
  it('callback failure stays unknown, not a safe retry rejection', () => {
    const raw = { final_execution_status: 'FINAL', receipts_outcome: [
      { id: 'call', outcome: { executor_id: 'pool', status: { SuccessReceiptId: 'callback' } } },
      { id: 'callback', outcome: { executor_id: 'pool', status: { Failure: 'callback failed after token transfer' } } },
    ] }
    expect(withdrawalReceipt(raw, 'pool', 'withdraw').kind).toBe('unknown')
  })
  it('requires terminal callback true, not outer success or pending disappearance', () => {
    expect(withdrawalReceipt(receipt(true), 'pool', 'withdraw').kind).toBe('paid')
    expect(withdrawalReceipt(receipt(false), 'pool', 'withdraw').kind).toBe('restored')
    expect(withdrawalReceipt({ status: { SuccessValue: btoa('true') } }, 'pool', 'withdraw').kind).toBe('unknown')
    const incomplete = receipt(true); incomplete.receipts_outcome.pop()
    expect(withdrawalReceipt(incomplete, 'pool', 'withdraw').kind).toBe('unknown')
  })
})
describe('read-only FINAL reconciliation through the actual store adapter', () => {
  const outcome = (method = 'withdraw', final_execution_status = 'EXECUTED_OPTIMISTIC', paid = true) => ({
    final_execution_status, transaction: { hash: method + '-tx', signer_id: 'relay' }, receipts_outcome: method === 'withdraw' ? [
      { id: 'call', block_hash: 'receipt-block', outcome: { executor_id: 'pool', status: { SuccessReceiptId: 'callback' } } },
      { id: 'callback', outcome: { executor_id: 'pool', status: { SuccessValue: btoa(JSON.stringify(paid)) } } },
    ] : [{ id: 'call', block_hash: 'receipt-block', outcome: { executor_id: 'pool', status: { SuccessValue: '' } } }],
  })
  function fixture() {
    const send = vi.fn(async (method: string) => outcome(method))
    const query = vi.fn<(args: { txHash: string; accountId: string; waitUntil: 'FINAL' }) => Promise<unknown>>(async () => outcome('withdraw', 'FINAL'))
    let height = 100; let now = 30; let pending = '40'; let ready: number | null = 30
    const provider = {
      viewTransactionStatusWithReceipts: query,
      viewBlock: vi.fn(async (args: { blockId?: string }) => ({ header: { hash: args.blockId ?? 'final-block', height: args.blockId ? 101 : height, timestamp_nanosec: String(BigInt(args.blockId ? 11 : now) * 1_000_000n) } })),
      callFunction: vi.fn(async (args: { method: string; blockQuery: { blockId: string } }) => args.method === 'get_liabilities' ? { in_flight: '0' } : args.blockQuery.blockId === 'receipt-block' ? { court: '60', withdraw_pending: '40', withdraw_ready_at: 30 } : { court: '100', withdraw_pending: pending, withdraw_ready_at: ready }),
    }
    const capture = () => ({ valid: () => true, send })
    const store: ContractStore = Object.assign(Object.create(ContractStore.prototype), { me: 'alice', identityGeneration: 0, near: { config: { rugpool: 'pool' }, provider, captureWithdrawalSession: capture, captureWalletWithdrawal: capture } })
    const markers = new Map<string, string>(); const release = vi.fn()
    const flow = new WithdrawalFlow({ acquire: async () => release, marker: { getItem: k => markers.get(k) ?? null, setItem: (k,v) => { markers.set(k,v) }, removeItem: k => { markers.delete(k) } } })
    return { flow, store, send, query, provider, markers, release, older: () => { now = 10; pending = '0'; ready = null }, fresh: () => { height = 102; now = 30; pending = '40'; ready = 30 } }
  }
  it.each([true, false])('keeps marker/ownership while optimistic; FINAL callback %s is terminal', async paid => {
    const f = fixture(); let resolve!: (value: unknown) => void
    f.query.mockReturnValue(new Promise(r => { resolve = r }))
    await f.flow.start(f.store.captureWithdrawal()); const tick = f.flow.tick()
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1))
    expect(f.flow.state.phase).toBe('withdrawing'); expect(f.markers.size).toBe(1); expect(f.release).not.toHaveBeenCalled()
    expect(f.query).toHaveBeenCalledWith({ txHash: 'withdraw-tx', accountId: 'relay', waitUntil: 'FINAL' })
    resolve(outcome('withdraw', 'FINAL', paid)); await tick
    expect(f.flow.state.phase).toBe(paid ? 'complete' : 'failed'); expect(f.markers.size).toBe(0); expect(f.release).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('finalizes request, ignores older final head, then completes with one send per stage', async () => {
    const f = fixture(); f.older(); f.query.mockResolvedValueOnce(outcome('request_withdraw', 'FINAL'))
    await f.flow.start(f.store.captureWithdrawal(), '40')
    expect(f.flow.state.phase).toBe('waiting'); expect(f.provider.viewBlock).toHaveBeenCalledWith({ blockId: 'receipt-block' })
    expect(f.provider.callFunction).toHaveBeenCalledWith(expect.objectContaining({ blockQuery: { blockId: 'receipt-block' } }))
    await f.flow.tick(); expect(f.flow.state.phase).toBe('waiting'); expect(f.send).toHaveBeenCalledTimes(1)
    f.fresh(); await f.flow.tick(); expect(f.flow.state.phase).toBe('complete'); expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('explicit wallet uses the same final evidence path without automation', async () => {
    const f = fixture(); await f.flow.start(f.store.captureWithdrawal(false), undefined, false)
    expect(f.flow.state.phase).toBe('complete'); expect(f.send).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(1)
  })
  it.each(['optimistic', 'throw', 'hang'] as const)('bounds %s status reads and retains uncertainty; no resend', async mode => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.query.mockImplementation(async () => { if (mode === 'throw') throw Error('private RPC detail'); if (mode === 'hang') return new Promise(() => {}); return outcome() })
      await f.flow.start(f.store.captureWithdrawal()); const tick = f.flow.tick()
      await vi.advanceTimersByTimeAsync(32_001); await tick
      expect(f.flow.state.phase).toBe('unknown'); expect(f.flow.state.id).toBe('withdraw-tx'); expect(f.markers.size).toBe(1); expect(f.release).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('a transient status error then FINAL safely completes without resending', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(); f.query.mockRejectedValueOnce(Error('not known yet'))
      await f.flow.start(f.store.captureWithdrawal()); const tick = f.flow.tick(); await vi.advanceTimersByTimeAsync(1_001); await tick
      expect(f.flow.state.phase).toBe('complete'); expect(f.query).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('stop while reading FINAL keeps unknown and never retries', async () => {
    const f = fixture(); let resolve!: (value: unknown) => void; f.query.mockReturnValue(new Promise(r => { resolve = r }))
    await f.flow.start(f.store.captureWithdrawal()); const tick = f.flow.tick(); await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1))
    f.flow.stop(); resolve(outcome('withdraw', 'FINAL')); await tick
    expect(f.flow.state.phase).toBe('unknown'); expect(f.markers.size).toBe(1); expect(f.release).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('the original total deadline wins over slow send plus finality; late FINAL cannot clear guards', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(); let resolve!: (value: unknown) => void
      f.send.mockImplementation(async method => { await new Promise(r => setTimeout(r, 55_000)); return outcome(method) })
      f.query.mockReturnValue(new Promise(r => { resolve = r }))
      await f.flow.start(f.store.captureWithdrawal()); const tick = f.flow.tick()
      await vi.advanceTimersByTimeAsync(60_000); await tick
      expect(f.flow.state.phase).toBe('unknown'); expect(f.query).toHaveBeenCalledTimes(1)
      resolve(outcome('withdraw', 'FINAL')); await vi.advanceTimersByTimeAsync(1_000)
      f.flow.stop(); await f.flow.tick()
      expect(f.flow.state.phase).toBe('unknown'); expect(f.markers.size).toBe(1); expect(f.release).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('missing identifiers or mismatched finalized identity never resolves uncertainty', async () => {
    const query = vi.fn(async () => ({ ...outcome('withdraw', 'FINAL'), transaction: { hash: 'wrong', signer_id: 'relay' } }))
    expect((await finalizedWithdrawalReceipt({ ...outcome(), transaction: { hash: 'withdraw-tx' } }, 'pool', 'withdraw', query, () => {})).kind).toBe('unknown')
    expect(query).not.toHaveBeenCalled()
    expect((await finalizedWithdrawalReceipt(outcome(), 'pool', 'withdraw', query, () => {})).kind).toBe('unknown')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
describe('captured-session-only boundary', () => {
  function fixture() {
    const session = { accountId: 'alice', signer: { sign: vi.fn(async (_r, _m, _a, _t, guard: () => void) => { guard(); return {} }) } }
    const near: Near = Object.assign(Object.create(Near.prototype), { config: { rugpool: 'pool', relayerUrl: 'https://relay.invalid' }, session })
    return { near, session }
  }
  it('missing session refuses instead of wallet fallback or renewal', () => {
    const { near } = fixture(); Object.assign(near, { session: null })
    expect(() => near.captureWithdrawalSession('alice')).toThrow()
  })
  it('identity change while signing prevents relay', async () => {
    const { near, session } = fixture(); const captured = near.captureWithdrawalSession('alice')
    session.signer.sign.mockImplementation(async () => { Object.assign(near, { session: null }); return {} })
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    try { await expect(captured.send('withdraw', {}, () => {})).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled() } finally { vi.unstubAllGlobals() }
  })
  it('session expiry never renews/retries/falls back', async () => {
    const { near, session } = fixture(); const captured = near.captureWithdrawalSession('alice')
    session.signer.sign.mockRejectedValue(Error('session key expired'))
    await expect(captured.send('withdraw', {}, () => {})).rejects.toThrow('expired')
    expect(session.signer.sign).toHaveBeenCalledTimes(1)
  })
})
