import type { AccountView, GameState } from './types'

/**
 * The one-time fee the contract keeps from the deposit that creates an account, in micro-USDC.
 * An account with nothing in it has been deleted (or never existed), except the King's, which
 * is kept until the crowning.
 */
export function registrationFeeDue(state: GameState, account: AccountView | null, me: string): number {
  const empty = [account?.balance, account?.court, account?.withdraw_pending, account?.court_earned, account?.king_stream].every((v) => Number(v ?? 0) === 0)
  return empty && state.round.king !== me ? Number(state.params.registration_fee ?? 0) : 0
}
