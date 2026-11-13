// The gas relayer's request handling, kept free of Node and network code so it can be tested:
// validate the wire delegate, apply the policy, rate-limit each player and each IP, and submit
// each key's actions in nonce order (a later nonce landing first would invalidate the earlier one).
//
// Anyone can post to a relayer, and the relayer pays for every transaction it sends, failed or
// not. So everything the chain would reject is refused here first: a bad signature, a key that
// can't sign that kind of action, an expired session key, a used nonce, an expired action.
//
// A session key's age comes from the earlier of two births: the one the relayer recorded durably
// (when it relayed the key change that added the key, or at first sight), and the one its nonce
// implies (NEAR seeds a new key's nonce at (height − 1) × 1e6). Neither alone is enough: the key
// holder picks nonces, and claims can be relayed by anyone, so a thief could push a stolen key's
// nonce up to look new; and a key the relayer never recorded (a lost store) must not look new.
// Pushing the nonce only ever makes it look younger, so the earlier of the two is safe.

import { encodeDelegateAction, type SignedDelegate } from 'near-api-js'
import { checkDelegate, type RelayKind, type RelayPolicy } from './relayPolicy'
import { fromWire, type WireDelegate } from './relayWire'

/** An access key as the chain reports it. */
export type KeyPermission = 'full' | { receiverId: string; methods: string[] }

export interface RelayDeps {
  policy: RelayPolicy
  /** Current block height, for the expiry checks. */
  height: () => Promise<bigint>
  /** The access key on the account, or null if there is none. Function-call `methods` empty = any. */
  accessKey: (accountId: string, publicKey: string) => Promise<{ nonce: bigint; permission: KeyPermission } | null>
  /** Submits the meta transaction at the relayer's expense and returns the outcome. */
  submit: (signed: SignedDelegate) => Promise<unknown>
  /** When each session key (`account/publicKey`) was added or first seen, durably. */
  keyBirths: KeyBirths
  now?: () => number
  /** Actions per player per minute. */
  perMinute?: number
  /** Actions per IP per minute, across players. */
  perIpMinute?: number
  /** Actions per minute across everyone: bounds what the relayer can be made to spend. */
  perMinuteTotal?: number
  /** Requests being checked or submitted at once, across everyone. */
  maxInflight?: number
}

export interface KeyBirths {
  get(key: string): bigint | undefined
  /** Resolves once the height is safely stored. */
  record(key: string, height: bigint): Promise<void>
}

export interface RelayReply {
  status: number
  body: { outcome?: unknown; error?: string }
}

/** A new key's nonce is (height − 1) × 1e6; the chain refuses nonces above (height + 1) × 1e6. */
const NONCE_PER_HEIGHT = 1_000_000n

const isString = (v: unknown): v is string => typeof v === 'string'

function isWireAction(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  switch (a.type) {
    case 'call':
      return ['methodName', 'args', 'gas', 'deposit'].every((k) => isString(a[k]))
    case 'addKey':
      return ['publicKey', 'receiverId', 'allowance'].every((k) => isString(a[k])) && Array.isArray(a.methodNames) && a.methodNames.every(isString)
    case 'deleteKey':
      return isString(a.publicKey)
    default:
      return false
  }
}

function isWire(v: unknown): v is WireDelegate {
  if (typeof v !== 'object' || v === null) return false
  const w = v as Record<string, unknown>
  const strings = ['senderId', 'receiverId', 'nonce', 'maxBlockHeight', 'publicKey', 'signature'].every((k) => isString(w[k]))
  return strings && Array.isArray(w.actions) && w.actions.length <= 16 && w.actions.every(isWireAction)
}

/** near-api-js throws on a failed transaction but attaches its outcome; the app wants the outcome. */
function failedOutcome(e: unknown): unknown {
  return typeof e === 'object' && e !== null && 'transactionResult' in e ? (e as { transactionResult: unknown }).transactionResult : undefined
}

/**
 * The rate-limit source for an IP: IPv4 as is, IPv6 by its /64 prefix (one host or network gets a
 * whole /64, so per-address limits would let it rotate around them).
 */
export function sourceOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (v4) return v4[1]!
  if (!ip.includes(':')) return ip
  const [head = '', tail = ''] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : []
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = ip.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** Why the signing key can't sign this kind of action, or null if it can (age is checked separately). */
function keyRefusal(kind: RelayKind, key: { nonce: bigint; permission: KeyPermission } | null, policy: RelayPolicy, method: string): string | null {
  if (!key) return kind === 'game' ? 'not a session key for this game' : 'not a key on this account'
  if (kind !== 'game') return key.permission === 'full' ? null : 'needs the account key'
  const p = key.permission
  if (p === 'full' || p.receiverId !== policy.pool || (p.methods.length > 0 && !p.methods.includes(method))) return 'not a session key for this game'
  return null
}

export function createRelayHandler(deps: RelayDeps): (body: unknown, meta?: { ip?: string }) => Promise<RelayReply> {
  const now = deps.now ?? Date.now
  const perMinute = deps.perMinute ?? 30
  const perIpMinute = deps.perIpMinute ?? 120
  const perMinuteTotal = deps.perMinuteTotal ?? 600
  const maxInflight = deps.maxInflight ?? 200
  const recent = new Map<string, number[]>()
  /** Each key's requests are checked and submitted one at a time, in arrival order. */
  const chains = new Map<string, Promise<unknown>>()
  let pending = 0
  /**
   * Requests in flight by key and nonce, from arrival until their reply. An exact resend (a
   * browser retrying the POST after a dropped connection) gets the original's result; the same
   * nonce with another signature is refused.
   */
  const inflight = new Map<string, { signature: string; run: Promise<RelayReply> }>()

  const within = (bucket: string, limit: number, t: number) => (recent.get(bucket) ?? []).filter((x) => t - x < 60_000).length < limit
  const record = (bucket: string, t: number) => {
    recent.set(bucket, [...(recent.get(bucket) ?? []).filter((x) => t - x < 60_000), t])
    if (recent.size > 10_000) {
      for (const [k, ts] of recent) if (ts.every((x) => t - x >= 60_000)) recent.delete(k)
    }
  }

  return async (body, meta = {}) => {
    if (!isWire(body)) return { status: 400, body: { error: 'Not a signed delegate action.' } }
    let signed: SignedDelegate
    try {
      signed = fromWire(body)
    } catch {
      return { status: 400, body: { error: 'Malformed delegate action.' } }
    }
    const d = signed.delegateAction
    const keyId = `${d.senderId}/${d.publicKey.toString()}`
    const id = `${keyId}/${d.nonce}`
    const same = inflight.get(id)
    if (same) return same.signature === body.signature ? same.run : { status: 400, body: { error: 'nonce already used' } }
    // Before anything awaits, only the sender's IP is charged: anyone can claim any account, so
    // unverified requests mustn't use up a player's (or everyone's) quota. The account and total
    // limits are charged in `process`, once the chain confirms the key and just before submitting.
    // Requests with no known IP share one bucket rather than skipping the limit.
    const ipBucket = `ip:${meta.ip ? sourceOf(meta.ip) : 'unknown'}`
    const t = now()
    if (pending >= maxInflight || !within(ipBucket, perIpMinute, t)) return { status: 429, body: { error: 'Too many actions; try again in a minute.' } }
    record(ipBucket, t)
    pending++
    // After the key's earlier requests, so each check sees the chain after the previous submit:
    // a lower nonce arriving behind a higher one is refused, not paid for.
    const run = (chains.get(keyId) ?? Promise.resolve()).then(() => process(signed))
    const tail = run.catch(() => undefined)
    chains.set(keyId, tail)
    inflight.set(id, { signature: body.signature, run })
    const done = () => {
      pending--
      if (inflight.get(id)?.run === run) inflight.delete(id)
      if (chains.get(keyId) === tail) chains.delete(keyId)
    }
    run.then(done, done)
    return run
  }

  async function process(signed: SignedDelegate): Promise<RelayReply> {
    const d = signed.delegateAction
    const sender = d.senderId
    const keyId = `${sender}/${d.publicKey.toString()}`
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeDelegateAction(d)))
    if (!d.publicKey.verify(hash, signed.signature.data)) return { status: 400, body: { error: 'bad signature' } }

    const height = await deps.height()
    const checked = checkDelegate(d, deps.policy, height)
    if ('error' in checked) return { status: 400, body: { error: checked.error } }
    // The chain refuses nonces above the block height × 1e6.
    if (d.nonce > (height + 1n) * NONCE_PER_HEIGHT) return { status: 400, body: { error: 'nonce too large' } }
    const key = await deps.accessKey(sender, d.publicKey.toString())
    const refused = keyRefusal(checked.kind, key, deps.policy, d.actions[0]?.functionCall?.methodName ?? '')
    if (refused || !key) return { status: 400, body: { error: refused ?? 'not a key on this account' } }
    if (d.nonce <= key.nonce) return { status: 400, body: { error: 'nonce already used' } }
    if (checked.kind === 'game') {
      // The key was added no later than its nonce says.
      const byNonce = key.nonce / NONCE_PER_HEIGHT
      let born = deps.keyBirths.get(keyId)
      if (born === undefined) await deps.keyBirths.record(keyId, (born = byNonce))
      if (byNonce < born) born = byNonce
      if (height - born > deps.policy.sessionMaxAgeBlocks) return { status: 400, body: { error: 'session key expired; sign in again' } }
    }
    // A key change may only delete session keys: never a full-access key, never another contract's.
    for (const a of d.actions) {
      if (!a.deleteKey) continue
      const target = await deps.accessKey(sender, a.deleteKey.publicKey.toString())
      if (!target || target.permission === 'full' || target.permission.receiverId !== deps.policy.pool) {
        return { status: 400, body: { error: 'only session keys can be deleted' } }
      }
    }

    // Charged only now that the chain shows the key is the account's and may sign this, so nobody
    // can use up a player's quota (or everyone's) by naming them. Checked and recorded together,
    // with nothing awaited in between, so a burst sent all at once is limited exactly like a stream.
    const t = now()
    if (!within('total', perMinuteTotal, t) || !within(`acct:${sender}`, perMinute, t)) return { status: 429, body: { error: 'Too many actions; try again in a minute.' } }
    record('total', t)
    record(`acct:${sender}`, t)
    // Session keys added by this change are aged from now.
    for (const a of d.actions) if (a.addKey) await deps.keyBirths.record(`${sender}/${a.addKey.publicKey.toString()}`, height)
    try {
      return { status: 200, body: { outcome: await deps.submit(signed) } }
    } catch (e) {
      const outcome = failedOutcome(e)
      return outcome === undefined ? { status: 502, body: { error: 'The relayer could not submit this action. Try again.' } } : { status: 200, body: { outcome } }
    }
  }
}
