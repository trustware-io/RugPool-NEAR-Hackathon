import { describe, expect, it } from 'vitest'
import { createActivation, type ActivationDeps, type ActivationRecord } from './activation'
import type { PrivyIdentity } from './identity'
import type { TransferAttempt, TransferOutcome } from './transfers'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const TARGET = 10_000n
const DAY = 86_400_000

/**
 * What a transfer's send does: lands and reports it; lands but the reply is lost; is lost before
 * landing (it may still land later); or is refused by the chain.
 */
type SendMode = 'lands' | 'landsReplyLost' | 'lost' | 'refused'

/**
 * A stand-in chain and ledger. Tokens are "user:account" strings, and a user named "guest…" has no
 * email; identity.test.ts covers real tokens. The chain reports an attempt as succeeded once it
 * landed, failed once refused or proven dead (`kill`), and unknown otherwise.
 */
function setup(over: Partial<ActivationDeps> = {}) {
  const balances = new Map<string, bigint>()
  const records: ActivationRecord[] = []
  const sent: Array<[string, bigint]> = []
  const landed = new Set<string>()
  const failed = new Set<string>()
  let mode: SendMode = 'lands'
  let n = 0
  let t = 10 * DAY
  const deps: ActivationDeps = {
    verify: async (token): Promise<PrivyIdentity> => {
      const [user, ...accounts] = token.split(':')
      if (!user) throw new Error('bad token')
      return { userId: user, nearAccounts: accounts, hasEmail: !user.startsWith('guest') }
    },
    balance: async (id) => balances.get(id) ?? null,
    transfers: {
      prepare: async (id, amount) => {
        const attempt: TransferAttempt = { tx: `tx${++n}`, nonce: String(n), height: '100', publicKey: 'ed25519:relayer', signed: 'AA==' }
        return {
          attempt,
          send: async (): Promise<'succeeded' | 'failed'> => {
            sent.push([id, amount])
            if (mode === 'refused') {
              failed.add(attempt.tx)
              return 'failed'
            }
            if (mode === 'lost') throw new Error('timed out; outcome unknown')
            balances.set(id, (balances.get(id) ?? 0n) + amount)
            landed.add(attempt.tx)
            if (mode === 'landsReplyLost') throw new Error('timed out; outcome unknown')
            return 'succeeded'
          },
        }
      },
      status: async (a): Promise<TransferOutcome> => (landed.has(a.tx) ? 'succeeded' : failed.has(a.tx) ? 'failed' : 'unknown'),
    },
    ledger: { all: () => records, put: async (r) => void records.push(r) },
    target: TARGET,
    perIpPerDay: 3,
    dailyBudget: 50_000n,
    now: () => t,
    ...over,
  }
  return {
    deps,
    activate: createActivation(deps),
    balances,
    records,
    sent,
    tick: (ms: number) => (t += ms),
    send: (m: SendMode) => (mode = m),
    /** The chain proves the attempt can never land (its nonce was used, or it expired). */
    kill: (tx: string) => failed.add(tx),
    /** A lost transfer that lands late. */
    land: (tx: string, id: string, amount: bigint) => {
      landed.add(tx)
      balances.set(id, (balances.get(id) ?? 0n) + amount)
    },
  }
}

const activateA = (s: ReturnType<typeof setup>, activate = s.activate) => activate({ idToken: `u1:${A}`, accountId: A }, { ip: '192.0.2.1' })

describe('account activation', () => {
  it('funds a new account once, for the login that owns it', async () => {
    const s = setup()
    expect(await s.activate({ idToken: `u1:${A}`, accountId: A })).toEqual({ status: 200, body: { state: 'funded', accountId: A } })
    expect(s.sent).toEqual([[A, TARGET]])
    expect(await s.activate({ idToken: `u1:${A}`, accountId: A })).toEqual({ status: 200, body: { state: 'already', accountId: A } })
    expect(s.sent).toHaveLength(1)
  })

  it("refuses an account the login doesn't own, or a bad token", async () => {
    const s = setup()
    expect((await s.activate({ idToken: `u1:${A}`, accountId: B })).status).toBe(403)
    expect((await s.activate({ idToken: '', accountId: A })).status).toBe(401)
    expect((await s.activate({ idToken: `u1:${A}`, accountId: 'bob.testnet' })).status).toBe(400)
    expect(s.sent).toHaveLength(0)
  })

  it('only funds email logins, never a guest', async () => {
    const s = setup()
    expect(await s.activate({ idToken: `guest1:${A}`, accountId: A })).toEqual({ status: 403, body: { error: 'Sign in with your email to get started.' } })
    expect(s.sent).toHaveLength(0)
    expect(s.records).toHaveLength(0)
  })

  it('activates one account per login and one login per account', async () => {
    const s = setup()
    await s.activate({ idToken: `u1:${A}:${B}`, accountId: A })
    expect((await s.activate({ idToken: `u1:${A}:${B}`, accountId: B })).status).toBe(409)
    expect((await s.activate({ idToken: `u2:${A}`, accountId: A })).status).toBe(409)
    expect(s.sent).toHaveLength(1)
  })

  it('shares one activation between concurrent requests', async () => {
    const s = setup()
    const replies = await Promise.all([1, 2, 3].map(() => s.activate({ idToken: `u1:${A}`, accountId: A })))
    expect(replies.every((r) => r.status === 200)).toBe(true)
    expect(s.sent).toEqual([[A, TARGET]])
  })

  it('tops up an account someone pre-created with dust, never past the target', async () => {
    const s = setup()
    s.balances.set(A, 3n)
    await s.activate({ idToken: `u1:${A}`, accountId: A })
    expect(s.sent).toEqual([[A, TARGET - 3n]])
    expect(s.balances.get(A)).toBe(TARGET)
  })

  it("doesn't pay an account that already holds the target", async () => {
    const s = setup()
    s.balances.set(A, TARGET * 2n)
    expect((await s.activate({ idToken: `u1:${A}`, accountId: A })).body.state).toBe('already')
    expect(s.sent).toHaveLength(0)
  })

  it('records the transfer it is about to send before sending it', async () => {
    const s = setup()
    const seen: ActivationRecord[][] = []
    const prepare = s.deps.transfers.prepare
    const activate = createActivation({
      ...s.deps,
      transfers: {
        ...s.deps.transfers,
        prepare: async (id, amount) => {
          const p = await prepare(id, amount)
          return { attempt: p.attempt, send: () => (seen.push([...s.records]), p.send()) }
        },
      },
    })
    await activateA(s, activate)
    expect(seen[0]).toEqual([expect.objectContaining({ state: 'pending', tx: 'tx1', attempt: expect.objectContaining({ tx: 'tx1', nonce: '1' }) })])
  })

  it('a transfer that landed but whose reply was lost is settled from the chain, not resent', async () => {
    const s = setup()
    s.send('landsReplyLost')
    expect((await activateA(s)).status).toBe(502)
    s.send('lands')
    expect((await activateA(s)).body).toEqual({ state: 'funded', accountId: A })
    expect(s.sent).toHaveLength(1)
    expect(s.balances.get(A)).toBe(TARGET)
    expect((await activateA(s)).body.state).toBe('already')
  })

  // Friday RP-CP1-001: a transfer with an unknown outcome was resent after 60 s, or after a restart.
  it('never resends a transfer whose outcome is unknown, however long it waits or restarts', async () => {
    const s = setup()
    s.send('lost')
    expect((await activateA(s)).status).toBe(502)
    s.send('lands')
    s.tick(61_000)
    const restarted = createActivation(s.deps)
    expect(await activateA(s, restarted)).toEqual({ status: 409, body: { error: 'Activation is still in progress. Try again in a minute.' } })
    s.tick(3 * DAY)
    expect((await activateA(s, restarted)).status).toBe(409)
    expect(s.sent).toHaveLength(1)
    // It lands late: the account is funded once, by that first transfer.
    s.land('tx1', A, TARGET)
    expect((await activateA(s, restarted)).body.state).toBe('funded')
    expect(s.sent).toHaveLength(1)
    expect(s.balances.get(A)).toBe(TARGET)
  })

  it('sends a new transfer once the chain proves the lost one can never land', async () => {
    const s = setup()
    s.send('lost')
    await activateA(s)
    s.kill('tx1')
    s.send('lands')
    expect((await activateA(s)).body.state).toBe('funded')
    expect(s.sent).toHaveLength(2)
    expect(s.balances.get(A)).toBe(TARGET)
  })

  it('tries again after the chain refuses a transfer', async () => {
    const s = setup()
    s.send('refused')
    expect((await activateA(s)).status).toBe(502)
    s.send('lands')
    expect((await activateA(s)).body.state).toBe('funded')
    expect(s.sent).toHaveLength(2)
    expect(s.balances.get(A)).toBe(TARGET)
  })

  it('stays blocked while the chain cannot be asked', async () => {
    const s = setup()
    s.send('lost')
    await activateA(s)
    const activate = createActivation({
      ...s.deps,
      transfers: {
        ...s.deps.transfers,
        status: async () => {
          throw new Error('rpc down')
        },
      },
    })
    expect((await activateA(s, activate)).status).toBe(502)
    expect(s.sent).toHaveLength(1)
  })

  // Friday RP-CP1-002: only the oldest pending attempt was looked at.
  it('is blocked by any unsettled attempt, not just the oldest', async () => {
    const s = setup()
    const base = { userId: 'u1', accountId: A, state: 'pending' as const, amount: TARGET.toString(), at: 10 * DAY }
    s.records.push({ ...base, tx: 'old', attempt: { tx: 'old', nonce: '1', height: '1', publicKey: 'ed25519:relayer', signed: 'AA==' } })
    s.records.push({ ...base, tx: 'new', attempt: { tx: 'new', nonce: '2', height: '2', publicKey: 'ed25519:relayer', signed: 'AA==' } })
    s.kill('old')
    expect((await activateA(s)).status).toBe(409)
    expect(s.sent).toHaveLength(0)
  })

  it('treats a pending record with no transfer identity as unsettled', async () => {
    const s = setup()
    s.records.push({ userId: 'u1', accountId: A, state: 'pending', amount: TARGET.toString(), at: 10 * DAY })
    expect((await activateA(s)).status).toBe(409)
    expect(s.sent).toHaveLength(0)
  })

  it('limits new accounts per IP per day', async () => {
    const s = setup()
    const ip = { ip: '198.51.100.7' }
    const statuses = []
    for (let i = 0; i < 4; i++) {
      const acct = String(i).repeat(64)
      statuses.push((await s.activate({ idToken: `u${i}:${acct}`, accountId: acct }, ip)).status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
    s.tick(DAY)
    expect((await s.activate({ idToken: `u9:${'9'.repeat(64)}`, accountId: '9'.repeat(64) }, ip)).status).toBe(200)
  })

  it('stops at the daily budget', async () => {
    const s = setup({ dailyBudget: TARGET * 2n })
    expect((await s.activate({ idToken: `u1:${A}`, accountId: A })).status).toBe(200)
    expect((await s.activate({ idToken: `u2:${B}`, accountId: B })).status).toBe(200)
    expect((await s.activate({ idToken: `u3:${C}`, accountId: C })).status).toBe(503)
    s.tick(DAY)
    expect((await s.activate({ idToken: `u3:${C}`, accountId: C })).status).toBe(200)
  })

  // Friday RP-CP1-002: retries were exempt from the budget.
  it('counts every transfer not proven failed against the budget, retries included', async () => {
    const s = setup({ dailyBudget: TARGET })
    s.send('lost')
    await activateA(s)
    s.tick(61_000)
    await activateA(s)
    await activateA(s)
    const reserved = s.records.filter((r) => r.state === 'pending').reduce((sum, r) => sum + BigInt(r.amount), 0n)
    expect(reserved).toBeLessThanOrEqual(TARGET)
    expect(s.sent).toHaveLength(1)
    // An unsettled transfer holds its share of the budget against everyone.
    s.send('lands')
    expect((await s.activate({ idToken: `u2:${B}`, accountId: B })).status).toBe(503)
    // Once proven failed it no longer counts, and the retry itself is checked against the budget.
    s.kill('tx1')
    expect((await activateA(s)).body.state).toBe('funded')
    expect((await s.activate({ idToken: `u2:${B}`, accountId: B })).status).toBe(503)
    expect(s.sent).toHaveLength(2)
  })

  it('holds the budget for transfers still being prepared, so a burst of sign-ups cannot overspend it', async () => {
    const s = setup({ dailyBudget: TARGET })
    const prepare = s.deps.transfers.prepare
    const activate = createActivation({
      ...s.deps,
      transfers: { ...s.deps.transfers, prepare: async (id, amount) => (await new Promise((r) => setTimeout(r, 5)), prepare(id, amount)) },
    })
    const replies = await Promise.all([A, B, C].map((acct, i) => activate({ idToken: `u${i}:${acct}`, accountId: acct })))
    expect(replies.map((r) => r.status).sort()).toEqual([200, 503, 503])
    expect(s.sent).toHaveLength(1)
    // A transfer that couldn't even be prepared gives its share back.
    const failing = createActivation({
      ...s.deps,
      transfers: {
        ...s.deps.transfers,
        prepare: async () => {
          throw new Error('rpc down')
        },
      },
    })
    s.tick(DAY)
    expect((await failing({ idToken: `u7:${'7'.repeat(64)}`, accountId: '7'.repeat(64) })).status).toBe(502)
    expect((await activate({ idToken: `u8:${'8'.repeat(64)}`, accountId: '8'.repeat(64) })).status).toBe(200)
  })

  it('checks a retry against the budget too', async () => {
    const s = setup({ dailyBudget: TARGET })
    s.send('refused')
    expect((await activateA(s)).status).toBe(502)
    // Someone else's activation spends the budget meanwhile.
    s.send('lands')
    expect((await s.activate({ idToken: `u2:${B}`, accountId: B })).status).toBe(200)
    expect((await activateA(s)).status).toBe(503)
    expect(s.sent).toHaveLength(2)
  })
})
