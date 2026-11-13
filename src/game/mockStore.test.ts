import { afterEach, describe, expect, it, vi } from 'vitest'
import { priceAt, pricesThisRound, splitTicket } from './curve'
import { MockStore, YOU } from './mockStore'
import { DEMO_PARAMS, SPEC_PARAMS, type EngineParams } from './params'
import { GameError, type GameErrorCode } from './types'

const USD = 1_000_000
const MAX = Number.MAX_SAFE_INTEGER

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function setup(params: EngineParams = DEMO_PARAMS) {
  let t = 1_700_000_000_000
  const s = new MockStore({ params, clock: () => t, rng: mulberry32(7), bots: false })
  return {
    s,
    advance(ms: number) {
      t += ms
      s.tick()
    },
    /** A deposit with a `challenge` msg is the contract's other challenge path. */
    ch(id: string, max = MAX) {
      s.ftOnTransfer(id, 0, { challenge: max })
    },
  }
}

async function you(s: MockStore, balance: number, court: number) {
  await s.connect()
  s.ftOnTransfer(YOU, balance + court)
  if (court > 0) await s.joinCourt(String(court))
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: GameErrorCode) {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    expect(e).toBeInstanceOf(GameError)
    expect((e as GameError).code).toBe(code)
    return e as GameError
  }
  throw new Error(`expected ${code}`)
}

const num = (v: string) => Number(v)

describe('curve', () => {
  it('starts at $5 and steps +3% per challenge, floored to micro-USDC', () => {
    expect(priceAt(0, 5 * USD, 300)).toBe(5_000_000)
    expect(priceAt(1, 5 * USD, 300)).toBe(5_150_000)
    expect(priceAt(2, 5 * USD, 300)).toBe(5_304_500)
    expect(pricesThisRound(3, 5 * USD, 300)).toEqual([5_000_000, 5_150_000, 5_304_500])
  })

  it('splits 55/25/15/5 and the parts always sum to the price', () => {
    expect(splitTicket(5_150_000, [5500, 2500, 1500, 500])).toEqual([2_832_500, 1_287_500, 772_500, 257_500])
    const rng = mulberry32(3)
    for (let i = 0; i < 2_000; i++) {
      const p = 1 + Math.floor(rng() * 1e9)
      const parts = splitTicket(p, [5500, 2500, 1500, 500])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(p)
      expect(parts[1]).toBe(Math.floor((p * 2500) / 10_000))
    }
  })
})

describe('challenge', () => {
  it('pays the dethroned King 25% and the Jackpot 55% (the King share too when there is no King)', async () => {
    const { s, ch } = setup()
    ch('alice.near')
    let st = await s.getState()
    expect(num(st.round.jackpot)).toBe(5_000_000 * 0.8)
    expect(st.round.king).toBe('alice.near')

    const before = num((await s.getAccount('alice.near')).balance)
    ch('degen.near')
    st = await s.getState()
    expect(num((await s.getAccount('alice.near')).balance) - before).toBe(1_287_500)
    expect(num(st.round.jackpot)).toBe(4_000_000 + 2_832_500)
    expect(st.round.next_price).toBe('5304500')
  })

  it('rejects with typed errors from the store', async () => {
    const { s, ch } = setup()
    await expectCode(s.challenge(String(MAX)), 'NOT_CONNECTED')
    await you(s, 50 * USD, 24_990_000)
    await expectCode(s.challenge(String(MAX)), 'COURT_TOO_SMALL')
    await s.joinCourt('10000')
    await s.challenge(String(MAX))
    await expectCode(s.challenge(String(MAX)), 'ALREADY_KING')
    ch('alice.near')
    const err = await expectCode(s.challenge('5000000'), 'PRICE_MOVED')
    expect(err.price).toBe('5304500')
    await expectCode(s.challenge('not a number'), 'INVALID_AMOUNT')
  })

  it('rejects when the balance cannot cover the ticket', async () => {
    const { s } = setup()
    await you(s, 4 * USD, 25 * USD)
    await expectCode(s.challenge(String(MAX)), 'INSUFFICIENT_BALANCE')
  })

  it('leaves deposit funds in the balance when the challenge msg fails', async () => {
    const { s } = setup()
    await you(s, 0, 25 * USD)
    expect(() => s.ftOnTransfer(YOU, 10 * USD, { challenge: 1 })).toThrow(GameError)
    expect((await s.getAccount(YOU)).balance).toBe(String(10 * USD))
  })
})

describe('auto-defend', () => {
  it('retakes the throne for the dethroned King in the same call', async () => {
    const { s, ch } = setup()
    ch('whale.near') // whale.near is armed up to $10 in the seed accounts
    await you(s, 100 * USD, 25 * USD)
    const { cursor } = await s.getEvents(0)
    await s.challenge(String(MAX))
    const { events } = await s.getEvents(cursor)
    expect(events.map((e) => e.type)).toEqual(['challenged', 'auto_defended'])
    expect((await s.getState()).round.king).toBe('whale.near')
  })

  it('stops an auto-defend war at exactly 25 retakes', async () => {
    const { s, ch } = setup(SPEC_PARAMS)
    ch('whale.near')
    await s.connect('whale.near')
    await s.setAutoDefend(String(1_000 * USD))
    await you(s, 10_000 * USD, 25 * USD)
    await s.setAutoDefend(String(1_000 * USD))
    const { cursor } = await s.getEvents(0)
    await s.challenge(String(MAX))
    const { events } = await s.getEvents(cursor)
    expect(events.filter((e) => e.type === 'auto_defended')).toHaveLength(25)
    // Retakes alternate whale, you, whale... so the 25th belongs to whale.
    expect((await s.getState()).round.king).toBe('whale.near')
  })
})

describe('round lifecycle', () => {
  it('starts the showdown when the Jackpot reaches the demo trigger ($20)', async () => {
    const { s, ch } = setup()
    const order = ['alice.near', 'degen.near']
    let i = 0
    while ((await s.getState()).round.showdown_ends_at === null) ch(order[i++ % 2]!)
    const st = await s.getState()
    expect(num(st.round.jackpot)).toBeGreaterThanOrEqual(20 * USD)
    const { events } = await s.getEvents(0)
    const sd = events.find((e) => e.type === 'showdown_started')
    expect(sd?.data).toMatchObject({ reason: 'size', ends_at: s.now() + 90_000 })
  })

  it('uses 0.2% of the Court as the trigger with spec params', async () => {
    const { s } = setup(SPEC_PARAMS)
    const st = await s.getState()
    expect(num(st.round.showdown_trigger)).toBe(Math.floor(num(st.court.total) * 0.002))
  })

  it('starts the showdown at the round-age backstop', async () => {
    const { s, advance } = setup()
    advance(5 * 60_000)
    const { events } = await s.getEvents(0)
    expect(events.find((e) => e.type === 'showdown_started')?.data).toMatchObject({ reason: 'time' })
  })

  it('pushes the end out to the snipe window only inside the last 15s', async () => {
    const { s, ch, advance } = setup()
    ch('alice.near')
    advance(5 * 60_000) // showdown by time, 90s on the clock
    const end = (await s.getState()).round.showdown_ends_at!
    advance(60_000) // 30s left: outside the window
    ch('degen.near')
    expect((await s.getState()).round.showdown_ends_at).toBe(end)
    advance(20_000) // 10s left: inside the window
    ch('alice.near')
    expect((await s.getState()).round.showdown_ends_at).toBe(s.now() + 15_000)
  })

  it('closes challenges at the end, then the keeper pays the King and opens the next round at $5', async () => {
    const { s, ch, advance } = setup()
    ch('alice.near')
    ch('degen.near')
    advance(5 * 60_000)
    advance(90_000)
    await s.connect()
    await expectCode(s.challenge(String(MAX)), 'ROUND_CLOSED')
    const jackpotAtEnd = num((await s.getState()).round.jackpot)
    const before = num((await s.getAccount('degen.near')).balance)
    advance(2_500)
    const st = await s.getState()
    expect(st.round.id).toBe(2)
    expect(st.round.next_price).toBe('5000000')
    expect(st.round.king).toBeNull()
    const settled = (await s.getEvents(0)).events.find((e) => e.type === 'round_settled')
    // Yield keeps seeding the Jackpot until the keeper lands settle_round.
    const paid = settled?.type === 'round_settled' ? num(settled.data.jackpot) : NaN
    expect(paid).toBeGreaterThanOrEqual(jackpotAtEnd)
    expect(num((await s.getAccount('degen.near')).balance) - before).toBe(paid)
    expect(settled?.data).toEqual({ winner: 'degen.near', jackpot: String(paid), multiple: Math.round((paid / 5_150_000) * 100) / 100 })
  })

  it('rolls the Jackpot over when a round ends with no King', async () => {
    const { s, advance } = setup()
    advance(5 * 60_000)
    advance(90_000)
    advance(2_500)
    const st = await s.getState()
    expect(st.round.id).toBe(2)
    const settled = (await s.getEvents(0)).events.find((e) => e.type === 'round_settled')
    expect(settled?.data).toMatchObject({ winner: null })
  })
})

describe('court', () => {
  it('gives a Court under $5 no draw odds', async () => {
    const { s } = setup()
    s.ftOnTransfer('bob', 4 * USD, { join: true })
    expect((await s.getAccount('bob')).court).toBe(String(4 * USD))
    expect((await s.getAccount('bob')).draw_weight_bps).toBe(0)
    s.ftOnTransfer('bob', 1 * USD, { join: true })
    expect((await s.getAccount('bob')).draw_weight_bps).toBeGreaterThan(0)
  })

  it('rolls the draw over when nobody meets the draw minimum', async () => {
    // Above every seeded Court, so no one is eligible.
    const { s, advance } = setup({ ...DEMO_PARAMS, drawMinCourt: 1_000_000 * USD })
    await you(s, 10 * USD, 30 * USD)
    await s.challenge(String(MAX))
    advance(DEMO_PARAMS.drawEveryMs)
    expect((await s.getEvents(0)).events.some((e) => e.type === 'draw_won')).toBe(false)
    expect(Number((await s.getState()).court.draw_pot)).toBeGreaterThan(0)
  })

  it('enforces the withdrawal cooldown', async () => {
    const { s, advance } = setup()
    await you(s, 0, 30 * USD)
    await expectCode(s.withdraw(), 'NOTHING_TO_WITHDRAW')
    await s.requestWithdraw(String(30 * USD))
    const pending = await s.getAccount(YOU)
    expect(pending.withdraw_ready_at).toBe(s.now() + 60_000)
    // Like the contract, the request takes the money out of the Court at once.
    expect([pending.court, pending.withdraw_pending, pending.draw_weight_bps]).toEqual(['0', String(30 * USD), 0])
    await expectCode(s.withdraw(), 'COOLDOWN')
    advance(60_000)
    await s.withdraw()
    const a = await s.getAccount(YOU)
    expect(a.court).toBe('0')
    expect(a.balance).toBe(String(30 * USD))
  })

  it('earns fees from challenges and pays them out on claim', async () => {
    const { s, ch } = setup()
    await you(s, 0, 1_000 * USD)
    await expectCode(s.claim(), 'NOTHING_TO_CLAIM')
    for (let i = 0; i < 6; i++) ch(i % 2 ? 'alice.near' : 'degen.near')
    const earned = num((await s.getAccount(YOU)).court_earned)
    expect(earned).toBeGreaterThan(0)
    await s.claim()
    const a = await s.getAccount(YOU)
    expect(num(a.balance)).toBeGreaterThanOrEqual(earned)
    expect(a.court_earned).toBe('0')
  })
})

describe('events and bots', () => {
  it('returns only events after the cursor', async () => {
    const { s, ch } = setup()
    ch('alice.near')
    const first = await s.getEvents(0)
    ch('degen.near')
    const next = await s.getEvents(first.cursor)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.id).toBeGreaterThan(first.cursor)
  })

  it('seeds a live round and keeps it moving with bots', async () => {
    let t = 1_700_000_000_000
    const s = new MockStore({ params: DEMO_PARAMS, clock: () => t, rng: mulberry32(11), seed: true })
    const start = await s.getEvents(0)
    expect((await s.getState()).round.king).not.toBeNull()
    for (let i = 0; i < 120; i++) {
      t += 250
      s.tick()
    }
    expect((await s.getEvents(start.cursor)).events.length).toBeGreaterThan(0)
  })

  afterEach(() => vi.restoreAllMocks())

  it('starts one timer even when start() runs twice', () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    const { s } = setup()
    s.start()
    s.start()
    s.stop()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
