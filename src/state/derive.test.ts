import { describe, expect, it } from 'vitest'
import type { AccountView, GameEvent, GameState } from '../game/types'
import { feedLine, settleQuip } from './copy'
import { autoDefendCover, phaseOf, playerOf } from './derive'
import { clock } from './format'

const state = (over: Partial<GameState['round']> = {}): GameState => ({
  round: { id: 1, challenges: 0, next_price: '5000000', king: null, king_since: null, started_at: 0, jackpot: '0', showdown_trigger: '20000000', showdown_ends_at: null, backstop_at: 300_000, ...over },
  court: { total: '50000000000', apy_bps_live: 300, next_draw_at: 0, draw_pot: '0' },
  params: { start_price: '5000000', step_bps: 300, split_bps: [5500, 2500, 1500, 500], min_court: '25000000', showdown_ms: 90_000, snipe_ms: 15_000 },
})
const acct = (over: Partial<AccountView> = {}): AccountView => ({ balance: '0', court: '0', court_earned: '0', draw_weight_bps: 0, king_stream: '0', auto_defend_max: '0', withdraw_pending: '0', withdraw_ready_at: null, ...over })

describe('derive', () => {
  it('walks the round lifecycle from contract timestamps', () => {
    expect(phaseOf(state(), 0)).toBe('open')
    expect(phaseOf(state({ king: 'a.near' }), 0)).toBe('building')
    expect(phaseOf(state({ king: 'a.near', showdown_ends_at: 1_000 }), 999)).toBe('showdown')
    expect(phaseOf(state({ king: 'a.near', showdown_ends_at: 1_000 }), 1_000)).toBe('settling')
  })

  it('maps accounts to player states', () => {
    expect(playerOf(state(), null, null)).toEqual({ kind: 'disconnected' })
    expect(playerOf(state(), acct({ court: '10000000' }), 'you.near')).toEqual({ kind: 'needs_court', missing: 15_000_000 })
    expect(playerOf(state(), acct({ court: '25000000' }), 'you.near')).toEqual({ kind: 'eligible' })
    expect(playerOf(state({ king: 'you.near' }), acct(), 'you.near')).toEqual({ kind: 'king' })
  })

  it('counts auto-defend retakes two curve steps apart and stops at the max or the balance', () => {
    // Next retake prices: k=1 $5.15, k=3 $5.4636, k=5 $5.7963...
    expect(autoDefendCover(state(), 5_500_000, 100_000_000)).toEqual({ retakes: 2, spend: 5_150_000 + 5_463_635 })
    expect(autoDefendCover(state(), 100_000_000, 6_000_000).retakes).toBe(1)
    expect(autoDefendCover(state(), 1_000_000_000, 1_000_000_000).retakes).toBe(25)
  })

  it('formats long countdowns in days', () => {
    expect(clock(15_000)).toBe('0:15')
    expect(clock(60_000)).toBe('1:00')
    expect(clock(7 * 86_400_000 - 1_000)).toBe('6d 23h')
  })
})

describe('copy', () => {
  const ev = (e: Omit<GameEvent, 'id' | 'at'>): GameEvent => ({ id: 1, at: 0, ...e }) as GameEvent

  it('speaks to the player in the second person', () => {
    const line = feedLine(ev({ type: 'challenged', data: { by: 'whale.near', price: '10000000', dethroned: 'you.near' } }), 'you.near', 2500)
    expect(line.text).toBe('whale.near rugged you for $10.00. You get $2.50 back.')
  })

  it('names the last King the winner dethroned and how long that King lasted', () => {
    const history: GameEvent[] = [
      { id: 1, at: 1_000, type: 'challenged', data: { by: 'alice.near', price: '5000000', dethroned: null } },
      { id: 2, at: 12_000, type: 'challenged', data: { by: 'whale.near', price: '5150000', dethroned: 'alice.near' } },
    ]
    const settled = { id: 3, at: 99_000, type: 'round_settled', data: { winner: 'whale.near', jackpot: '9000000', multiple: 1.7 } } as const
    expect(settleQuip(history, settled, null)).toBe('alice.near, you were King for 11 seconds. Here is your 25%.')
  })
})
