// In-memory RugPool engine with bots, ported from RugPool_Frontend_Prototype.html.
// It plays the contract's role: integer micro-USDC money, events with a cursor, and a
// keeper that settles rounds and runs the draw. Components only see the GameStore views.

import { priceAt, splitTicket } from './curve'
import type { EngineParams } from './params'
import {
  GameError,
  type AccountView,
  type EventPage,
  type GameEvent,
  type GameState,
  type GameStore,
  type U128,
} from './types'

const YEAR_MS = 365 * 24 * 3_600_000
/** The keeper lands `settle_round` this long after the showdown clock hits zero. */
const SETTLE_DELAY_MS = 2_500
/** Bots compress a day of activity into a minute, so the live APY is annualized at that rate. */
const ACTIVITY_COMPRESSION = 1440
const EVENT_LOG_MAX = 200
const PAGE_MAX = 50

type EventInput = GameEvent extends infer E ? (E extends GameEvent ? Omit<E, 'id' | 'at'> : never) : never

interface Account {
  id: string
  balance: number
  court: number
  /** Fractional micro-USDC accrues here; views floor it. */
  earned: number
  kingStream: number
  autoMax: number
  withdrawReadyAt: number | null
  withdrawPending: number
}

interface Bot {
  id: string
  /** Highest ticket the bot will pay. */
  max: number
  /** Only challenges while the Jackpot is at least `ratio` x the price. */
  ratio: number
  sniper?: boolean
}

interface Round {
  id: number
  k: number
  king: string | null
  kingSince: number | null
  startedAt: number
  jackpot: number
  showdownEndsAt: number | null
  settleAt: number | null
  lastPrice: number
}

export interface MockStoreOptions {
  params: EngineParams
  clock?: () => number
  rng?: () => number
  bots?: boolean
  /** Seed history and a live round so the page is busy on load. */
  seed?: boolean
  pollMs?: number
}

export const YOU = 'you.near'

export class MockStore implements GameStore {
  readonly params: EngineParams
  readonly pollMs: number
  private readonly clock: () => number
  private readonly rng: () => number
  private botsOn: boolean
  private accounts = new Map<string, Account>()
  private bots: Bot[] = []
  private round!: Round
  private events: GameEvent[] = []
  private nextEventId = 1
  private courtTotal = 0
  private drawPot = 0
  private protocol = 0
  private feesToCourt = 0
  private startedAt: number
  private lastPoke: number
  private nextDrawAt: number
  private nextBotAt: number
  private folded = new Set<string>()
  private snipedRound = 0
  private connected: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: MockStoreOptions) {
    this.params = opts.params
    this.clock = opts.clock ?? Date.now
    this.rng = opts.rng ?? Math.random
    this.botsOn = opts.bots ?? true
    this.pollMs = opts.pollMs ?? 500
    const now = this.clock()
    this.startedAt = now
    this.lastPoke = now
    this.nextDrawAt = now + this.params.drawEveryMs
    this.nextBotAt = now + 2_500

    const usd = (v: number) => v * 1_000_000
    for (const [id, court] of [['dao.near', 18_000], ['ben.near', 12_000], ['cass.near', 9_000], ['lp-vault.near', 10_560]] as const) {
      this.addAccount(id, 0, usd(court))
    }
    this.bots = [
      { id: 'alice.near', max: usd(14), ratio: 4 },
      { id: 'degen.near', max: usd(32), ratio: 2 },
      { id: 'whale.near', max: usd(60), ratio: 1.3 },
      { id: 'sniper.bot', max: usd(60), ratio: 2, sniper: true },
    ]
    for (const b of this.bots) this.addAccount(b.id, usd(5_000), usd(100))
    // Low enough that a demo player with auto-defend can outlast whale once prices climb.
    this.get('whale.near').autoMax = usd(10)

    if (opts.seed) this.seed(now)
    else this.openRound(now, 1, 0)
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Safe to call more than once (React StrictMode runs effects twice). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 250)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setBots(on: boolean): void {
    this.botsOn = on
  }

  botsEnabled(): boolean {
    return this.botsOn
  }

  /** Keeper + bots step. Public so tests can drive the clock. */
  tick(): void {
    const now = this.clock()
    this.poke(now)
    this.keeper(now)
    if (this.botsOn) this.botTick(now)
  }

  // ---- GameStore: session -----------------------------------------------------

  now(): number {
    return this.clock()
  }

  accountId(): string | null {
    return this.connected
  }

  /** The mock signs in as `you.near`; tests can sign in as any account. */
  async connect(id: string = YOU): Promise<string> {
    if (!this.accounts.has(id)) this.addAccount(id, 0, 0)
    this.connected = id
    return id
  }

  async disconnect(): Promise<void> {
    this.connected = null
  }

  // ---- GameStore: views ---------------------------------------------------------

  async getState(): Promise<GameState> {
    const p = this.params
    const r = this.round
    return {
      round: {
        id: r.id,
        challenges: r.k,
        next_price: String(this.price()),
        king: r.king,
        king_since: r.kingSince,
        started_at: r.startedAt,
        jackpot: String(Math.floor(r.jackpot)),
        showdown_trigger: String(this.trigger()),
        showdown_ends_at: r.showdownEndsAt,
        backstop_at: r.startedAt + p.backstopMs,
      },
      court: {
        total: String(this.courtTotal),
        apy_bps_live: this.apyBps(),
        next_draw_at: this.nextDrawAt,
        draw_pot: String(Math.floor(this.drawPot)),
      },
      params: {
        start_price: String(p.startPrice),
        step_bps: p.stepBps,
        split_bps: p.splitBps,
        min_court: String(p.minCourt),
        showdown_ms: p.showdownMs,
        snipe_ms: p.snipeMs,
      },
    }
  }

  async getAccount(id: string): Promise<AccountView> {
    const a = this.accounts.get(id)
    if (!a) {
      return { balance: '0', court: '0', court_earned: '0', draw_weight_bps: 0, king_stream: '0', auto_defend_max: '0', withdraw_pending: '0', withdraw_ready_at: null }
    }
    return {
      balance: String(Math.floor(a.balance)),
      court: String(a.court),
      court_earned: String(Math.floor(a.earned)),
      draw_weight_bps: this.inDraw(a) ? Math.round((a.court / this.drawTotal()) * 10_000) : 0,
      king_stream: String(Math.floor(a.kingStream)),
      auto_defend_max: String(a.autoMax),
      withdraw_pending: String(a.withdrawPending),
      withdraw_ready_at: a.withdrawReadyAt,
    }
  }

  async getEvents(cursor: number): Promise<EventPage> {
    const newer = this.events.filter((e) => e.id > cursor)
    const page = newer.slice(-PAGE_MAX)
    const last = this.events[this.events.length - 1]
    return { events: page, cursor: last ? Math.max(cursor, last.id) : cursor }
  }

  // ---- GameStore: actions -------------------------------------------------------

  async challenge(maxPrice: U128): Promise<void> {
    const now = this.clock()
    this.poke(now)
    this.doChallenge(this.signer(), Number(maxPrice), now)
  }

  async setAutoDefend(max: U128): Promise<void> {
    const v = Number(max)
    if (!Number.isFinite(v) || v < 0) throw new GameError('INVALID_AMOUNT', 'Max price must be zero or more.')
    this.get(this.signer()).autoMax = Math.floor(v)
  }

  async joinCourt(amount: U128): Promise<void> {
    const now = this.clock()
    this.poke(now)
    this.doJoin(this.signer(), Number(amount), now)
  }

  async requestWithdraw(amount: U128): Promise<void> {
    const a = this.get(this.signer())
    const v = Number(amount)
    if (!Number.isFinite(v) || v <= 0 || v > a.court) throw new GameError('INVALID_AMOUNT', 'Amount must be more than zero and at most your Court deposit.')
    // Like the contract: the money leaves the Court now, so it stops earning and stops counting
    // toward the minimum and the draw. A second request restarts the cooldown for all of it.
    const amt = Math.floor(v)
    a.court -= amt
    this.courtTotal -= amt
    a.withdrawPending += amt
    a.withdrawReadyAt = this.clock() + this.params.withdrawCooldownMs
  }

  async withdraw(): Promise<void> {
    const now = this.clock()
    this.poke(now)
    const a = this.get(this.signer())
    if (a.withdrawReadyAt === null || a.withdrawPending <= 0) throw new GameError('NOTHING_TO_WITHDRAW', 'Request a withdrawal first.')
    if (now < a.withdrawReadyAt) throw new GameError('COOLDOWN', 'The withdrawal cooldown has not ended.')
    const amt = a.withdrawPending
    a.balance += amt
    a.withdrawPending = 0
    a.withdrawReadyAt = null
    this.emit(now, { type: 'withdraw', data: { by: a.id, amount: String(amt) } })
  }

  async claim(): Promise<void> {
    this.poke(this.clock())
    const a = this.get(this.signer())
    const amt = Math.floor(a.earned) + Math.floor(a.kingStream)
    if (amt < 1) throw new GameError('NOTHING_TO_CLAIM', 'Nothing to claim yet.')
    a.earned -= Math.floor(a.earned)
    a.kingStream -= Math.floor(a.kingStream)
    a.balance += amt
  }

  /**
   * USDC arriving through `ft_transfer_call`. It always credits the balance first, then
   * runs the msg. If the follow-up fails, the funds stay in the balance and the error is thrown.
   */
  ftOnTransfer(id: string, amount: number, msg?: { join: true } | { challenge: number }): void {
    const now = this.clock()
    this.poke(now)
    if (!this.accounts.has(id)) this.addAccount(id, 0, 0)
    this.get(id).balance += Math.floor(amount)
    if (!msg) return
    if ('join' in msg) this.doJoin(id, Math.floor(amount), now)
    else this.doChallenge(id, msg.challenge, now)
  }

  // ---- engine -------------------------------------------------------------------

  private price(): number {
    return priceAt(this.round.k, this.params.startPrice, this.params.stepBps)
  }

  private trigger(): number {
    return this.params.triggerFixed ?? Math.floor((this.courtTotal * this.params.triggerBps) / 10_000)
  }

  private isClosed(now: number): boolean {
    const end = this.round.showdownEndsAt
    return end !== null && now >= end
  }

  private doJoin(id: string, amount: number, now: number): void {
    const a = this.get(id)
    if (!Number.isFinite(amount) || amount <= 0) throw new GameError('INVALID_AMOUNT', 'Amount must be more than zero.')
    if (a.balance < amount) throw new GameError('INSUFFICIENT_BALANCE', 'Not enough in your game balance.')
    a.balance -= amount
    a.court += amount
    this.courtTotal += amount
    this.emit(now, { type: 'court_join', data: { by: id, amount: String(amount) } })
  }

  private doChallenge(id: string, maxPrice: number, now: number): void {
    const a = this.get(id)
    const p = this.price()
    if (!Number.isFinite(maxPrice)) throw new GameError('INVALID_AMOUNT', 'Max price must be a number.')
    if (this.isClosed(now)) throw new GameError('ROUND_CLOSED', 'The showdown is over. The King is being crowned.')
    if (a.court < this.params.minCourt) throw new GameError('COURT_TOO_SMALL', 'You need $25 in the Court to challenge.')
    if (this.round.king === id) throw new GameError('ALREADY_KING', 'You are already the King.')
    if (p > maxPrice) throw new GameError('PRICE_MOVED', 'The price moved above your max.', String(p))
    if (a.balance < p) throw new GameError('INSUFFICIENT_BALANCE', 'Not enough in your game balance.')

    let dethroned = this.takeThrone(a, false, now)
    // The dethroned King's auto-defend answers in the same transaction, which can start a war.
    for (let retakes = 0; dethroned && retakes < this.params.maxRetakes; retakes++) {
      const d = this.get(dethroned)
      const np = this.price()
      if (!(d.autoMax > 0 && np <= d.autoMax && d.balance >= np && d.court >= this.params.minCourt)) break
      dethroned = this.takeThrone(d, true, now)
    }
  }

  /** Pays the curve price and crowns `a`. Returns the dethroned King. */
  private takeThrone(a: Account, auto: boolean, now: number): string | null {
    const r = this.round
    const p = this.price()
    const [jack, kingShare, court, protocol] = splitTicket(p, this.params.splitBps)
    a.balance -= p
    r.jackpot += jack
    const prev = r.king
    if (prev) this.get(prev).balance += kingShare
    else r.jackpot += kingShare
    // Assumption carried from the prototype: half the Court fee goes to depositors, half to the draw pot.
    const toRewards = Math.floor(court / 2)
    this.distributeToCourt(toRewards)
    this.feesToCourt += toRewards
    this.drawPot += court - toRewards
    this.protocol += protocol

    r.king = a.id
    r.kingSince = now
    r.k++
    r.lastPrice = p

    if (auto && prev) this.emit(now, { type: 'auto_defended', data: { by: a.id, price: String(p), against: prev } })
    else this.emit(now, { type: 'challenged', data: { by: a.id, price: String(p), dethroned: prev } })

    if (r.showdownEndsAt === null && r.jackpot >= this.trigger()) this.startShowdown('size', now)
    else if (r.showdownEndsAt !== null && r.showdownEndsAt - now < this.params.snipeMs) r.showdownEndsAt = now + this.params.snipeMs
    return prev
  }

  private startShowdown(reason: 'size' | 'time', now: number): void {
    this.round.showdownEndsAt = now + this.params.showdownMs
    this.emit(now, { type: 'showdown_started', data: { reason, ends_at: this.round.showdownEndsAt } })
  }

  /** Accrues yield (Court / Jackpot seed / King stream) and starts the showdown at the backstop. */
  private poke(now: number): void {
    const dt = Math.max(0, now - this.lastPoke)
    this.lastPoke = now
    if (dt > 0 && this.courtTotal > 0) {
      const y = (this.courtTotal * this.params.yieldApyBps * dt) / 10_000 / YEAR_MS
      const [toCourt, toSeed, toKing] = this.params.yieldSplitBps.map((b) => (y * b) / 10_000) as [number, number, number]
      this.distributeToCourt(toCourt)
      this.round.jackpot += toSeed
      if (this.round.king) this.get(this.round.king).kingStream += toKing
      else this.round.jackpot += toKing
    }
    const r = this.round
    if (r.showdownEndsAt === null && now >= r.startedAt + this.params.backstopMs) this.startShowdown('time', now)
  }

  private keeper(now: number): void {
    const r = this.round
    if (r.showdownEndsAt !== null && now >= r.showdownEndsAt) {
      if (r.settleAt === null) r.settleAt = now + SETTLE_DELAY_MS
      else if (now >= r.settleAt) this.settle(now)
    }
    if (now >= this.nextDrawAt) this.runDraw(now)
  }

  private settle(now: number): void {
    const r = this.round
    const pot = Math.floor(r.jackpot)
    if (!r.king) {
      this.emit(now, { type: 'round_settled', data: { winner: null, jackpot: String(pot), multiple: 0 } })
      this.openRound(now, r.id + 1, r.jackpot)
      return
    }
    this.get(r.king).balance += pot
    const multiple = Math.round((pot / r.lastPrice) * 100) / 100
    this.emit(now, { type: 'round_settled', data: { winner: r.king, jackpot: String(pot), multiple } })
    this.openRound(now, r.id + 1, r.jackpot - pot)
  }

  private openRound(now: number, id: number, carry: number): void {
    this.round = { id, k: 0, king: null, kingSince: null, startedAt: now, jackpot: carry, showdownEndsAt: null, settleAt: null, lastPrice: 0 }
    this.folded.clear()
  }

  private runDraw(now: number): void {
    this.nextDrawAt = now + this.params.drawEveryMs
    const pot = Math.floor(this.drawPot)
    const total = this.drawTotal()
    if (pot < 1 || total <= 0) return
    let pick = this.rng() * total
    let winner: Account | null = null
    for (const a of this.accounts.values()) {
      if (!this.inDraw(a)) continue
      winner = a
      if (pick < a.court) break
      pick -= a.court
    }
    if (!winner) return
    winner.balance += pot
    this.drawPot -= pot
    this.emit(now, { type: 'draw_won', data: { by: winner.id, amount: String(pot) } })
  }

  private inDraw(a: Account): boolean {
    return a.court >= this.params.drawMinCourt
  }

  private drawTotal(): number {
    let total = 0
    for (const a of this.accounts.values()) if (this.inDraw(a)) total += a.court
    return total
  }

  private distributeToCourt(amount: number): void {
    if (amount <= 0 || this.courtTotal <= 0) return
    for (const a of this.accounts.values()) if (a.court > 0) a.earned += (amount * a.court) / this.courtTotal
  }

  private apyBps(): number {
    const base = (this.params.yieldApyBps * this.params.yieldSplitBps[0]) / 10_000
    const elapsed = Math.max(this.clock() - this.startedAt, 10 * 60_000) * ACTIVITY_COMPRESSION
    const fees = this.courtTotal > 0 ? (this.feesToCourt / this.courtTotal) * (YEAR_MS / elapsed) * 10_000 : 0
    return Math.round(base + fees)
  }

  // ---- bots -------------------------------------------------------------------------

  private botTick(now: number): void {
    const r = this.round
    if (this.isClosed(now)) return
    const inShowdown = r.showdownEndsAt !== null

    const sniper = this.bots.find((b) => b.sniper)
    if (sniper && inShowdown && r.showdownEndsAt! - now < 3_000 && r.king !== sniper.id && this.snipedRound !== r.id) {
      const p = this.price()
      if (p <= sniper.max && r.jackpot >= sniper.ratio * p) {
        this.snipedRound = r.id
        this.tryBot(sniper.id, now)
        return
      }
    }

    if (now < this.nextBotAt) return
    this.nextBotAt = now + (inShowdown ? 3_000 + this.rng() * 5_000 : 2_500 + this.rng() * 5_000)
    const cands = this.bots.filter((b) => !b.sniper && b.id !== r.king && !this.folded.has(b.id))
    if (!cands.length) return
    const b = cands[Math.floor(this.rng() * cands.length)]!
    // In the showdown, bots lose their nerve so rounds actually end.
    if (inShowdown && this.rng() < 0.3) {
      this.folded.add(b.id)
      return
    }
    const p = this.price()
    if (p <= b.max && (r.k < 3 || r.jackpot >= b.ratio * p)) this.tryBot(b.id, now)
  }

  private tryBot(id: string, now: number): void {
    try {
      this.doChallenge(id, this.price(), now)
    } catch (e) {
      if (!(e instanceof GameError)) throw e
    }
  }

  // ---- seed ---------------------------------------------------------------------

  private seed(now: number): void {
    const usd = (v: number) => String(Math.round(v * 1_000_000))
    const ago = (s: number) => now - s * 1000
    this.emit(ago(900), { type: 'round_settled', data: { winner: 'whale.near', jackpot: usd(41.2), multiple: 3.4 } })
    this.emit(ago(720), { type: 'draw_won', data: { by: 'cass.near', amount: usd(6.85) } })
    this.emit(ago(560), { type: 'round_settled', data: { winner: 'degen.near', jackpot: usd(27.95), multiple: 2.9 } })
    this.emit(ago(300), { type: 'round_settled', data: { winner: 'sniper.bot', jackpot: usd(22.4), multiple: 3.8 } })
    this.openRound(ago(95), 4, 0)
    const seq: [string, number][] = [['alice.near', 80], ['degen.near', 61], ['alice.near', 44], ['whale.near', 27], ['degen.near', 9]]
    for (const [id, s] of seq) this.doChallenge(id, Number.MAX_SAFE_INTEGER, ago(s))
  }

  // ---- helpers --------------------------------------------------------------------

  private emit(at: number, e: EventInput): void {
    this.events.push({ ...e, id: this.nextEventId++, at } as GameEvent)
    if (this.events.length > EVENT_LOG_MAX) this.events.splice(0, this.events.length - EVENT_LOG_MAX)
  }

  private addAccount(id: string, balance: number, court: number): void {
    this.accounts.set(id, { id, balance, court, earned: 0, kingStream: 0, autoMax: 0, withdrawReadyAt: null, withdrawPending: 0 })
    this.courtTotal += court
  }

  private get(id: string): Account {
    const a = this.accounts.get(id)
    if (!a) throw new Error(`Unknown account ${id}`)
    return a
  }

  private signer(): string {
    if (!this.connected) throw new GameError('NOT_CONNECTED', 'Connect a wallet first.')
    return this.connected
  }
}
