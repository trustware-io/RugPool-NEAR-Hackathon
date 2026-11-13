import { describe, expect, it } from 'vitest'
import { registrationFeeDue } from './fee'
import type { AccountView, GameState } from './types'

const state = (fee: string | undefined, king: string | null = null) =>
  ({ round: { king }, params: { registration_fee: fee } }) as unknown as GameState
const empty: AccountView = { balance: '0', court: '0', court_earned: '0', draw_weight_bps: 0, king_stream: '0', auto_defend_max: '0', withdraw_pending: '0', withdraw_ready_at: null }

describe('registration fee', () => {
  it('is due on an account the contract has not stored', () => {
    expect(registrationFeeDue(state('50000'), null, 'carol.testnet')).toBe(50_000)
    expect(registrationFeeDue(state('50000'), empty, 'carol.testnet')).toBe(50_000)
  })

  it('is not due while anything is left in the account', () => {
    for (const k of ['balance', 'court', 'court_earned', 'king_stream', 'withdraw_pending'] as const) {
      expect(registrationFeeDue(state('50000'), { ...empty, [k]: '1' }, 'carol.testnet')).toBe(0)
    }
  })

  it('is not due for the King, whose empty account is kept until the crowning', () => {
    expect(registrationFeeDue(state('50000', 'carol.testnet'), empty, 'carol.testnet')).toBe(0)
  })

  it('is zero before M8 or with no fee set', () => {
    expect(registrationFeeDue(state(undefined), null, 'carol.testnet')).toBe(0)
    expect(registrationFeeDue(state('0'), null, 'carol.testnet')).toBe(0)
  })
})
