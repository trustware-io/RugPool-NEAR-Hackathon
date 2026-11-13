// GameStore backed by the RugPool contract on NEAR testnet (rehearsal): the Court, challenges,
// showdown and settlement, and auto-defend.

import { returnValue, type Near } from '../near/near'
import type { PrivySession } from '../privy/privySession'
import type { PrivyNearWallet } from '../privy/signer'
import { GameError, type AccountView, type EmailSignIn, type EventPage, type GameEvent, type GameEventType, type GameState, type GameStore, type U128 } from './types'

/** Chain time drifts slowly, so one block query every 30s is plenty. */
const CLOCK_SYNC_MS = 30_000
/** A challenge can set off an auto-defend war of up to 25 retakes; a full war measured 10 Tgas. */
const CHALLENGE_TGAS = 100
/**
 * The events the UI knows how to show. The contract also logs operator events (`deposit_held`)
 * and may add more after an upgrade; those are dropped here rather than crashing the feed.
 */
const SHOWN: ReadonlySet<string> = new Set<GameEventType>(['challenged', 'auto_defended', 'showdown_started', 'round_settled', 'court_join', 'withdraw', 'draw_won'])

export class ContractStore implements GameStore {
  readonly pollMs = 2_000
  private readonly near: Near
  private readonly privy: PrivySession | null
  readonly emailSignIn?: EmailSignIn
  private me: string | null = null
  /** Chain time minus local time. */
  private offset = 0
  private syncedAt = 0

  constructor(near: Near, privy: PrivySession | null = null) {
    this.near = near
    this.privy = privy
    void near.restoredAccount().then((id) => {
      if (id && !this.me) this.me = id
    })
    if (privy) {
      this.emailSignIn = {
        sendCode: (email) => privy.sendCode(email),
        verify: async (email, code) => this.signInWithPrivy(privy, await privy.login(email, code)),
      }
      // A Privy login kept from an earlier visit signs back in, reusing the session key.
      void privy.restore().then((wallet) => (wallet && !this.me ? this.signInWithPrivy(privy, wallet) : null), () => null)
    }
    near.connector.on('wallet:signOut', () => {
      this.me = null
    })
  }

  now(): number {
    return Date.now() + this.offset
  }

  accountId(): string | null {
    return this.me
  }

  async connect(): Promise<string> {
    this.me = await this.near.connect()
    return this.me
  }

  async disconnect(): Promise<void> {
    await this.near.disconnect()
    await this.privy?.logout()
    this.me = null
  }

  private async signInWithPrivy(privy: PrivySession, wallet: PrivyNearWallet): Promise<string> {
    await this.near.signInWith(wallet.address, await privy.signer(wallet), () => privy.identityToken())
    this.me = wallet.address
    return wallet.address
  }

  async getState(): Promise<GameState> {
    if (Date.now() - this.syncedAt > CLOCK_SYNC_MS) {
      // Best effort: a failed block query keeps the old offset rather than failing the poll.
      this.syncedAt = Date.now()
      const sent = Date.now()
      await this.near.chainNowMs().then((chainMs) => {
        this.offset = chainMs - (sent + Date.now()) / 2
      }, () => {})
    }
    return this.near.view<GameState>(this.near.config.rugpool, 'get_state')
  }

  getAccount(id: string): Promise<AccountView> {
    return this.near.view<AccountView>(this.near.config.rugpool, 'get_account', { account_id: id })
  }

  async getEvents(cursor: number): Promise<EventPage> {
    const page = await this.near.view<{ events: Array<{ type: string }>; cursor: number }>(this.near.config.rugpool, 'get_events', { from: cursor })
    return { events: page.events.filter((e): e is GameEvent => SHOWN.has(e.type)), cursor: page.cursor }
  }

  async challenge(maxPrice: U128): Promise<void> {
    try {
      await this.act('challenge', { max_price: maxPrice }, CHALLENGE_TGAS)
    } catch (e) {
      // The contract refuses without saying where the price went; the retry flow needs it.
      if (e instanceof GameError && e.code === 'PRICE_MOVED') {
        const state = await this.getState().catch(() => null)
        throw state ? new GameError('PRICE_MOVED', e.message, state.round.next_price) : e
      }
      throw e
    }
  }

  async setAutoDefend(max: U128): Promise<void> {
    await this.act('set_auto_defend', { max_price: max })
  }

  async joinCourt(amount: U128): Promise<void> {
    await this.act('join_court', { amount })
  }

  async requestWithdraw(amount: U128): Promise<void> {
    await this.act('request_withdraw', { amount })
  }

  async withdraw(): Promise<void> {
    await this.payout('withdraw')
  }

  async claim(): Promise<void> {
    await this.payout('claim')
  }

  /** `withdraw` and `claim` return false when the token transfer failed and the funds were restored. */
  private async payout(method: 'withdraw' | 'claim'): Promise<void> {
    const paid = await this.act(method, {}, 60)
    if (paid !== true) throw new Error('The USDC transfer to your wallet failed, so your funds are back in RugPool. Check that your wallet is registered with the token, then try again.')
  }

  /** Relayed with the session key when there is one (no popup, no gas); otherwise the wallet signs. */
  private async act(method: string, args: Record<string, unknown>, tgas = 30): Promise<unknown> {
    if (!this.me) throw new GameError('NOT_CONNECTED', 'Connect a wallet first.')
    const contract = this.near.config.rugpool
    const outcome = (await this.near.relayCall(contract, method, args, { tgas })) ?? (await this.near.call(contract, method, args, { tgas }))
    return returnValue(outcome)
  }
}
