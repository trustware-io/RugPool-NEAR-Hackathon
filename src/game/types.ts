// Shapes mirror the contract views in RugPool_Frontend_Spec.md: amounts are USDC
// 6-decimal integers as strings, times are Unix milliseconds.

export type U128 = string

export interface RoundView {
  id: number
  challenges: number
  next_price: U128
  king: string | null
  king_since: number | null
  started_at: number
  jackpot: U128
  showdown_trigger: U128
  showdown_ends_at: number | null
  backstop_at: number
}

export interface CourtView {
  total: U128
  apy_bps_live: number
  next_draw_at: number
  draw_pot: U128
  /** A closed draw waiting for its drand round to pick the winner. Absent before M10. */
  pending_draw?: { round: number; pot: U128 } | null
}

export interface ParamsView {
  start_price: U128
  step_bps: number
  /** Jackpot, dethroned King, Court, protocol. */
  split_bps: [number, number, number, number]
  min_court: U128
  showdown_ms: number
  snipe_ms: number
  /** Kept from the first deposit that creates an account. Absent before M8. */
  registration_fee?: U128
}

export interface GameState {
  round: RoundView
  court: CourtView
  params: ParamsView
  /** The owner has stopped new play. Claims and withdrawals still work. */
  paused?: boolean
}

export interface AccountView {
  balance: U128
  court: U128
  court_earned: U128
  draw_weight_bps: number
  king_stream: U128
  auto_defend_max: U128
  /** Court money on its way out: it no longer earns, counts toward the minimum or enters the draw. */
  withdraw_pending: U128
  withdraw_ready_at: number | null
}

interface EventBase {
  /** Cursor position; strictly increasing. */
  id: number
  at: number
}

export type GameEvent = EventBase &
  (
    | { type: 'challenged'; data: { by: string; price: U128; dethroned: string | null } }
    | { type: 'auto_defended'; data: { by: string; price: U128; against: string } }
    | { type: 'showdown_started'; data: { reason: 'size' | 'time'; ends_at: number } }
    | { type: 'round_settled'; data: { winner: string | null; jackpot: U128; multiple: number } }
    | { type: 'court_join'; data: { by: string; amount: U128 } }
    | { type: 'withdraw'; data: { by: string; amount: U128 } }
    | { type: 'draw_won'; data: { by: string; amount: U128 } }
  )

export type GameEventType = GameEvent['type']

export interface EventPage {
  events: GameEvent[]
  /** Pass back as `getEvents(cursor)` to receive only newer events. */
  cursor: number
}

export type GameErrorCode =
  | 'NOT_CONNECTED'
  | 'COURT_TOO_SMALL'
  | 'ALREADY_KING'
  | 'ROUND_CLOSED'
  | 'PRICE_MOVED'
  | 'INSUFFICIENT_BALANCE'
  | 'COOLDOWN'
  | 'NOTHING_TO_WITHDRAW'
  | 'NOTHING_TO_CLAIM'
  | 'INVALID_AMOUNT'
  | 'PAUSED'
  | 'CAP_REACHED'
  | 'COURT_FULL'
  | 'BUY_LOCKED'
  | 'UNTRUSTED_RELAYER'

export class GameError extends Error {
  readonly code: GameErrorCode
  /** For PRICE_MOVED: the current price in micro-USDC. */
  readonly price?: U128

  constructor(code: GameErrorCode, message: string, price?: U128) {
    super(message)
    this.name = 'GameError'
    this.code = code
    this.price = price
  }
}

/**
 * The only surface components use. `MockStore` implements it now; `ContractStore`
 * (near-api-js + wallet selector) implements it later. Write methods act for the
 * connected account. `connect`/`disconnect`/`accountId`/`now` are additions to the
 * spec's method list: the wallet selector and the contract clock need a home.
 */
/** Email sign-in (Privy): a one-time code, then the player's own NEAR account. */
export interface EmailSignIn {
  sendCode(email: string): Promise<void>
  /** Signs in with the code and returns the account id, session key included. */
  verify(email: string, code: string): Promise<string>
}

export interface GameStore {
  /** Suggested poll interval for views. The spec's contract value is 2000ms. */
  readonly pollMs: number
  /** Chain time estimate (local clock + offset). Never trust the raw local clock. */
  now(): number
  accountId(): string | null
  connect(): Promise<string>
  disconnect(): Promise<void>
  /** Offered next to `connect` (a NEAR wallet) where the store supports it. */
  readonly emailSignIn?: EmailSignIn

  getState(): Promise<GameState>
  getAccount(id: string): Promise<AccountView>
  getEvents(cursor: number): Promise<EventPage>

  challenge(maxPrice: U128): Promise<void>
  setAutoDefend(max: U128): Promise<void>
  joinCourt(amount: U128): Promise<void>
  requestWithdraw(amount: U128): Promise<void>
  withdraw(): Promise<void>
  claim(): Promise<void>
}
