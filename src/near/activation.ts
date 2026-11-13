// One-time activation of a new player's NEAR account, paid by the relayer. A Privy NEAR wallet is
// an implicit account that doesn't exist on chain until someone sends it NEAR; it needs a little
// for its own storage and its session key's. Every later action is relayed, so this is the only
// NEAR a player ever holds.
//
// Funding is bound to a verified Privy email login (identity.ts); a guest login, which has no
// email and costs nothing to create, is never funded. One activation per Privy user and per
// account. An account is only topped up to `target`, so an account someone else created with
// dust still gets activated.
//
// Each transfer is signed first and recorded in a durable ledger, with its transaction identity,
// before it is sent (transfers.ts). A transfer whose outcome is unknown (the send timed out, the
// process restarted) is settled from the chain before anything else happens for that login or
// account. No new transfer is sent while an earlier one might still land, however long ago it
// was sent. Every transfer not proven failed counts against the daily budget, retries included.
// Per-IP and per-day limits bound what a flood of fresh email logins could cost.

import { isImplicitAccount, type PrivyIdentity } from './identity'
import type { TransferAttempt, Transfers } from './transfers'

export interface ActivationRecord {
  userId: string
  accountId: string
  state: 'pending' | 'funded' | 'failed'
  /** yoctoNEAR sent (or about to be). */
  amount: string
  /** ms since epoch, when the record was written. */
  at: number
  /** The transfer's hash. Absent when an account already held the target and nothing was sent. */
  tx?: string
  /** On a pending record: the signed transfer, recorded before it is sent. */
  attempt?: TransferAttempt
}

/** Durable storage: `put` resolves only once the record is safely written. */
export interface Ledger {
  all(): ActivationRecord[]
  put(record: ActivationRecord): Promise<void>
}

export interface ActivationDeps {
  verify: (idToken: string) => Promise<PrivyIdentity>
  /** The account's balance in yoctoNEAR, or null if it doesn't exist yet. */
  balance: (accountId: string) => Promise<bigint | null>
  transfers: Transfers
  ledger: Ledger
  /** The balance an activated account is topped up to. */
  target: bigint
  perIpPerDay: number
  /** Most yoctoNEAR spent on activations per UTC day. */
  dailyBudget: bigint
  now?: () => number
}

export interface ActivationReply {
  status: number
  body: { state?: 'funded' | 'already'; accountId?: string; error?: string }
}

const DAY_MS = 86_400_000
const IN_PROGRESS: ActivationReply = { status: 409, body: { error: 'Activation is still in progress. Try again in a minute.' } }
const TAKEN: ActivationReply = { status: 409, body: { error: 'This login or account was already activated.' } }
const UNAVAILABLE: ActivationReply = { status: 502, body: { error: 'Could not activate the account. Try again in a minute.' } }

/** Each transfer by its pending record, with the latest state recorded for it. */
function transfersIn(records: ActivationRecord[]): Array<{ start: ActivationRecord; state: ActivationRecord['state'] }> {
  const byTx = new Map<string, { start: ActivationRecord; state: ActivationRecord['state'] }>()
  const out: Array<{ start: ActivationRecord; state: ActivationRecord['state'] }> = []
  for (const r of records) {
    if (r.state === 'pending') {
      const t = { start: r, state: r.state }
      out.push(t)
      if (r.tx) byTx.set(r.tx, t)
    } else if (r.tx) {
      const t = byTx.get(r.tx)
      if (t) t.state = r.state
    }
  }
  return out
}

export function createActivation(deps: ActivationDeps): (body: unknown, meta?: { ip?: string }) => Promise<ActivationReply> {
  const now = deps.now ?? Date.now
  const inflight = new Map<string, Promise<ActivationReply>>()
  /** Activations started per IP today. Kept in memory: an IP address is personal data. */
  const perIp = new Map<string, { day: number; count: number }>()
  /**
   * Budget held by transfers being prepared, which aren't in the ledger yet. Checked and taken
   * together, with nothing awaited in between, so a burst of sign-ups can't all pass the check.
   */
  let preparing = 0n

  /** What today's transfers may have spent: every one not proven failed, by the day it started. */
  const spentToday = (day: number) =>
    transfersIn(deps.ledger.all()).reduce((sum, t) => (t.state !== 'failed' && Math.floor(t.start.at / DAY_MS) === day ? sum + BigInt(t.start.amount) : sum), 0n)

  async function activate(identity: PrivyIdentity, accountId: string, ip: string | undefined): Promise<ActivationReply> {
    const { userId } = identity
    const ours = (r: ActivationRecord) => r.userId === userId || r.accountId === accountId
    const samePair = (r: ActivationRecord) => r.userId === userId && r.accountId === accountId
    const funded = deps.ledger.all().find((r) => r.state === 'funded' && ours(r))
    if (funded) return samePair(funded) ? { status: 200, body: { state: 'already', accountId } } : TAKEN
    const earlier = transfersIn(deps.ledger.all()).filter((t) => ours(t.start))
    const open = earlier.filter((t) => t.state === 'pending')
    if (open.some((t) => !samePair(t.start))) return TAKEN

    // Settle every earlier transfer before deciding anything else.
    for (const { start } of open) {
      if (!start.attempt || !start.tx) return IN_PROGRESS
      let outcome
      try {
        outcome = await deps.transfers.status(start.attempt)
      } catch {
        return UNAVAILABLE
      }
      if (outcome === 'unknown') return IN_PROGRESS
      await deps.ledger.put({ userId, accountId, state: outcome === 'succeeded' ? 'funded' : 'failed', amount: start.amount, at: now(), tx: start.tx })
      if (outcome === 'succeeded') return { status: 200, body: { state: 'funded', accountId } }
    }

    const t = now()
    const day = Math.floor(t / DAY_MS)
    const balance = (await deps.balance(accountId)) ?? 0n
    const need = deps.target - balance
    if (need <= 0n) {
      await deps.ledger.put({ userId, accountId, state: 'funded', amount: '0', at: t })
      return { status: 200, body: { state: 'already', accountId } }
    }
    // A retry after a failed transfer isn't a new account, so only first attempts count per IP.
    if (earlier.length === 0 && ip) {
      const c = perIp.get(ip)
      if (c && c.day === day && c.count >= deps.perIpPerDay) return { status: 429, body: { error: 'Too many new accounts from this network today.' } }
      perIp.set(ip, { day, count: c && c.day === day ? c.count + 1 : 1 })
    }
    if (spentToday(day) + preparing + need > deps.dailyBudget) return { status: 503, body: { error: 'New sign-ups are paused for today. Try again tomorrow.' } }
    preparing += need
    let prepared
    try {
      prepared = await deps.transfers.prepare(accountId, need)
      await deps.ledger.put({ userId, accountId, state: 'pending', amount: need.toString(), at: t, tx: prepared.attempt.tx, attempt: prepared.attempt })
    } catch {
      return UNAVAILABLE
    } finally {
      // Once in the ledger, spentToday counts it.
      preparing -= need
    }
    let outcome
    try {
      outcome = await prepared.send()
    } catch {
      // Unknown: it may still land. The next request settles it from the chain.
      return UNAVAILABLE
    }
    await deps.ledger.put({ userId, accountId, state: outcome === 'succeeded' ? 'funded' : 'failed', amount: need.toString(), at: now(), tx: prepared.attempt.tx })
    return outcome === 'succeeded' ? { status: 200, body: { state: 'funded', accountId } } : UNAVAILABLE
  }

  return async (body, meta = {}) => {
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const { idToken, accountId } = b
    if (typeof idToken !== 'string' || typeof accountId !== 'string' || !isImplicitAccount(accountId)) return { status: 400, body: { error: 'Send idToken and a NEAR implicit accountId.' } }
    let identity: PrivyIdentity
    try {
      identity = await deps.verify(idToken)
    } catch {
      return { status: 401, body: { error: 'Sign in again.' } }
    }
    if (!identity.hasEmail) return { status: 403, body: { error: 'Sign in with your email to get started.' } }
    if (!identity.nearAccounts.includes(accountId)) return { status: 403, body: { error: 'That account does not belong to this login.' } }
    // Concurrent requests for the same login or account share one activation.
    const lock = inflight.get(identity.userId) ?? inflight.get(accountId)
    if (lock) return lock
    const run = activate(identity, accountId, meta.ip).finally(() => {
      inflight.delete(identity.userId)
      inflight.delete(accountId)
    })
    inflight.set(identity.userId, run)
    inflight.set(accountId, run)
    return run
  }
}
