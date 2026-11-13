import { priceAt } from '../game/curve'
import type { AccountView, GameState } from '../game/types'

export type Phase = 'open' | 'building' | 'showdown' | 'settling'

export function phaseOf(s: GameState, now: number): Phase {
  const end = s.round.showdown_ends_at
  if (end !== null) return now >= end ? 'settling' : 'showdown'
  return s.round.king ? 'building' : 'open'
}

export type Player =
  | { kind: 'disconnected' }
  | { kind: 'needs_court'; missing: number }
  | { kind: 'king' }
  | { kind: 'eligible' }

export function playerOf(s: GameState, a: AccountView | null, me: string | null): Player {
  if (!me || !a) return { kind: 'disconnected' }
  if (s.round.king === me) return { kind: 'king' }
  const missing = Number(s.params.min_court) - Number(a.court)
  if (missing > 0) return { kind: 'needs_court', missing }
  return { kind: 'eligible' }
}

export const nextPrice = (s: GameState) => Number(s.round.next_price)

/** Price one step after the next, the default max-price guard. */
export const guardPrice = (s: GameState) => priceAt(s.round.challenges + 1, Number(s.params.start_price), s.params.step_bps)

/** What the next King gets back if rugged right after: 25% of the price after theirs. */
export const rugBack = (s: GameState) => Math.floor((guardPrice(s) * s.params.split_bps[1]) / 10_000)

/** Showdown progress: the further along of Jackpot-vs-trigger and age-vs-backstop. */
export function progress(s: GameState, now: number): number {
  if (s.round.showdown_ends_at !== null) return 1
  const size = Number(s.round.jackpot) / Math.max(1, Number(s.round.showdown_trigger))
  const age = (now - s.round.started_at) / Math.max(1, s.round.backstop_at - s.round.started_at)
  return Math.min(1, Math.max(size, age))
}

/**
 * Retakes auto-defend covers from the balance: each retake happens after someone else
 * challenges, so the price moves two steps between retakes.
 */
export function autoDefendCover(s: GameState, max: number, balance: number): { retakes: number; spend: number } {
  const start = Number(s.params.start_price)
  let k = s.round.challenges + 1
  let left = balance
  let retakes = 0
  let spend = 0
  while (retakes < 25) {
    const p = priceAt(k, start, s.params.step_bps)
    if (p > max || p > left) break
    left -= p
    spend += p
    retakes++
    k += 2
  }
  return { retakes, spend }
}
