// Authority lives only in this controller, never in storage. Snapshots detect observed drift;
// withdraw() has no amount/version predicate and pays ALL pending to the same account.
export interface Snapshot { height: number; court: string; pending: string; ready: number | null; now: number; inFlight: string }
export type WithdrawalResult = { kind: 'request'; snapshot: Snapshot; id?: string } | { kind: 'paid' | 'restored' | 'unknown' | 'rejected'; id?: string }
export interface WithdrawalPort {
  key: string
  valid(): boolean
  read(): Promise<Snapshot>
  send(method: 'request_withdraw' | 'withdraw', amount: string | undefined, guard: () => void): Promise<WithdrawalResult>
}
export interface FlowState { phase: 'idle' | 'requesting' | 'waiting' | 'withdrawing' | 'complete' | 'paused' | 'unknown' | 'failed'; message: string; ready?: number; id?: string; requestId?: string; scope?: string }
interface Dependencies {
  acquire(key: string): Promise<() => void>
  marker: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}
export class WithdrawalFlow {
  state: FlowState = { phase: 'idle', message: '' }
  private listeners = new Set<() => void>()
  private port?: WithdrawalPort
  private expected?: Snapshot
  private release?: () => void
  private occupied = false
  private reading = false
  private armed = false
  private sending = false
  private requestId?: string
  constructor(private deps: Dependencies) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  snapshot = () => this.state
  private update(state: FlowState) { this.state = { scope: this.port?.key, requestId: this.requestId, ...state }; this.listeners.forEach(fn => fn()) }
  private markerKey(port: WithdrawalPort) { return `rugpool:withdrawal-outcome:${port.key}` }
  private guard = () => { if (!this.armed || !this.port?.valid()) throw Error('Account/session changed or automatic completion stopped.') }
  private height(s: Snapshot) {
    if (!Number.isSafeInteger(s.height) || s.height < 0) throw Error('Withdrawal block height unavailable.')
  }
  private safe(s: Snapshot) {
    this.height(s)
    if (!/^\d+$/.test(s.court) || !/^\d+$/.test(s.pending) || !/^\d+$/.test(s.inFlight) || !Number.isSafeInteger(s.now) || (s.ready !== null && !Number.isSafeInteger(s.ready))) throw Error('Withdrawal data unavailable.')
    if (BigInt(s.inFlight) !== 0n) throw Error('A payout is in flight (possibly another player’s). Automatic completion stopped; check again explicitly later.')
  }
  private unlock() {
    // Unknown submission retains ownership as well as the reload-blocking marker.
    if (this.state.phase === 'unknown') return
    this.release?.(); this.release = undefined; this.occupied = false
  }
  stop = () => {
    this.armed = false
    if (this.state.phase === 'unknown') return
    if (this.occupied) this.update({ phase: this.sending ? 'unknown' : 'paused', message: this.sending ? 'Submission may be in progress. Stopping cannot cancel a broadcast. Checking outcome; do not retry.' : 'Automatic completion stopped. Requested funds remain pending; this does not reverse Court exit.' })
    if (!this.sending && !this.reading) this.unlock()
  }
  inspectRecovery(key: string) {
    if (this.occupied || this.state.phase !== 'idle') return
    try {
      if (this.deps.marker.getItem(`rugpool:withdrawal-outcome:${key}`)) this.update({ phase: 'unknown', message: 'An earlier submission has an unresolved outcome. Reload does not authorize a retry. Reconcile its receipt before continuing.' })
    } catch { this.pause(Error('Recovery storage unavailable; withdrawal disabled until it can be checked.')) }
  }
  async start(port: WithdrawalPort, amount?: string, automatic = true) {
    if (this.occupied || this.state.phase === 'unknown') return
    this.occupied = true; this.armed = true; this.port = port; this.expected = undefined
    this.requestId = undefined
    this.update({ phase: 'requesting', message: 'Checking withdrawal and existing session…' })
    this.reading = true
    try {
      this.release = await this.deps.acquire(port.key); this.guard()
      if (this.deps.marker.getItem(this.markerKey(port))) {
        this.update({ phase: 'unknown', message: 'An earlier submission has an unresolved outcome. Reload does not authorize a retry. Reconcile its receipt before continuing.' }); this.armed = false; return
      }
      const before = await port.read(); this.guard(); this.safe(before)
      if (amount !== undefined) {
        if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > BigInt(before.court)) throw Error('Invalid Court amount.')
        const result = await this.submit('request_withdraw', amount)
        this.requestId = result.id
        if (result.kind !== 'request') { this.finish(result); return }
        this.guard(); this.safe(result.snapshot)
        const s = result.snapshot
        if (BigInt(s.pending) !== BigInt(before.pending) + BigInt(amount) || BigInt(s.court) !== BigInt(before.court) - BigInt(amount) || s.ready === null || s.ready < s.now) throw Error('Post-request state changed unexpectedly. Automatic completion stopped.')
        this.expected = s
      } else {
        if (BigInt(before.pending) <= 0n || before.ready === null) throw Error('No pending withdrawal to finish. Zero pending is not payment confirmation.')
        this.expected = before
      }
      this.guard()
      if (!automatic) {
        if (amount !== undefined) { this.pause(Error('Court withdrawal requested. Use the explicit wallet finish action after the cooldown; no automatic completion is armed.')); return }
        const s = this.expected
        if (s.ready === null || s.now < s.ready) throw Error('Cooldown has not ended. No wallet transaction sent; finish explicitly when ready.')
        this.finish(await this.submit('withdraw')); return
      }
      this.update({ phase: 'waiting', ready: this.expected.ready!, message: 'Cooldown — we’ll finish all pending Court withdrawals automatically while this page stays open.' })
    } catch (e) { this.pause(e) }
    finally { this.reading = false; if (!this.armed) this.unlock() }
  }
  private async submit(method: 'request_withdraw' | 'withdraw', amount?: string): Promise<WithdrawalResult> {
    this.guard()
    // Persist BEFORE any possible relay. Storage failure prevents send, never grants retries.
    this.deps.marker.setItem(this.markerKey(this.port!), JSON.stringify({ stage: method }))
    this.sending = true
    this.update({ phase: method === 'withdraw' ? 'withdrawing' : 'requesting', message: method === 'withdraw' ? 'Withdrawing all pending funds to your account…' : 'Requesting withdrawal from Court…' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // This bounds our response wait, not the transaction. Never cancel or retry a
      // possibly broadcast send. The losing promise has no state-changing handler.
      let result = await Promise.race([
        this.port!.send(method, amount, this.guard),
        new Promise<WithdrawalResult>(resolve => {
          timer = setTimeout(() => { this.armed = false; resolve({ kind: 'unknown' }) }, 60_000)
        }),
      ])
      if (!this.armed || !this.port!.valid()) result = { kind: 'unknown', id: result.id }
      if (result.kind !== 'unknown') {
        try { this.deps.marker.removeItem(this.markerKey(this.port!)) } catch { /* terminal evidence remains true; a stale marker is conservatively blocking on reload */ }
      } else if (result.id) {
        try { this.deps.marker.setItem(this.markerKey(this.port!), JSON.stringify({ stage: method, id: result.id })) } catch { /* original marker remains */ }
      }
      return result
    } catch { return { kind: 'unknown' } as const }
    finally { clearTimeout(timer); this.sending = false }
  }
  private finish(result: WithdrawalResult) {
    this.armed = false
    this.update({ phase: result.kind === 'paid' ? 'complete' : result.kind === 'unknown' ? 'unknown' : 'failed', id: result.id, message: result.kind === 'paid' ? 'Withdrawal complete — payout callback confirmed success.' : result.kind === 'restored' ? 'Token transfer failed; the contract restored pending funds. No automatic retry.' : result.kind === 'unknown' ? 'Outcome unknown. Do not retry; pending balance alone cannot confirm payment.' : 'Transaction rejected. Automatic completion stopped.' })
  }
  private pause(e: unknown) { this.armed = false; this.update({ phase: 'paused', message: e instanceof Error ? e.message : 'Unable to verify withdrawal. Automatic completion stopped.' }) }
  async tick() {
    if (!this.armed || this.reading || this.state.phase !== 'waiting') return
    this.reading = true
    try {
      this.guard(); const s = await this.port!.read(); this.guard(); this.height(s)
      // A lagging final head is not drift and cannot authorize payout via its clock.
      if (s.height < this.expected!.height) return
      this.safe(s)
      if (s.pending !== this.expected!.pending || s.ready !== this.expected!.ready) throw Error('Pending amount or cooldown changed. Automatic completion stopped; review current pending funds.')
      this.expected = s // monotonic observation floor, including during cooldown
      if (s.ready === null || s.now < s.ready) return
      // No intervening UI timer authorizes a send. Adapter rechecks binding before sign/relay.
      this.finish(await this.submit('withdraw'))
    } catch (e) { this.pause(e) }
    finally { this.reading = false; if (!this.armed) this.unlock() }
  }
}

export async function acquireWithdrawalLock(key: string): Promise<() => void> {
  if (!globalThis.navigator?.locks) throw Error('This browser cannot safely coordinate withdrawal tabs. Automatic completion unavailable.')
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`rugpool:withdrawal:${key}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { reject(Error('Another tab owns this withdrawal.')); return }
      await new Promise<void>(release => resolve(release))
    }).catch(reject)
  })
}
