// Privy email sign-in for the app: login, the player's Privy NEAR wallet (an implicit account,
// created on first login), and a signer for it that works in the page.

import './bufferShim'
import Privy, { LocalStorage, create } from '@privy-io/js-sdk-core'
import { PrivyNearSigner, mountPrivyWallet, type PrivyNearWallet } from './signer'

function nearWallet(user: { linked_accounts: readonly object[] }): PrivyNearWallet | null {
  for (const a of user.linked_accounts) {
    if ('type' in a && a.type === 'wallet' && 'chain_type' in a && a.chain_type === 'near' && 'address' in a && typeof a.address === 'string' && 'id' in a && typeof a.id === 'string') {
      return { id: a.id, address: a.address }
    }
  }
  return null
}

export class PrivySession {
  readonly privy: Privy
  private readonly appId: string

  constructor(appId: string) {
    this.appId = appId
    this.privy = new Privy({ appId, storage: new LocalStorage() })
  }

  sendCode(email: string): Promise<void> {
    return this.privy.auth.email.sendCode(email).then(() => {})
  }

  async login(email: string, code: string): Promise<PrivyNearWallet> {
    await this.privy.auth.email.loginWithCode(email, code)
    return this.wallet()
  }

  /** The wallet of a login kept from an earlier visit, if any. */
  async restore(): Promise<PrivyNearWallet | null> {
    if (!(await this.privy.user.get().catch(() => null))) return null
    return this.wallet()
  }

  /** The player's Privy NEAR wallet, creating it on first login. */
  async wallet(): Promise<PrivyNearWallet> {
    const existing = nearWallet((await this.privy.user.get()).user)
    if (existing) return existing
    await create({ fetchPrivyRoute: this.privy.fetchPrivyRoute.bind(this.privy), getCompiledPath: this.privy.getCompiledPath.bind(this.privy), app: { appId: this.appId } }, { request: { chain_type: 'near' } })
    const created = nearWallet((await this.privy.user.get()).user)
    if (!created) throw new Error('Privy did not link a NEAR wallet.')
    return created
  }

  async signer(wallet: PrivyNearWallet): Promise<PrivyNearSigner> {
    await mountPrivyWallet(this.privy)
    return new PrivyNearSigner(this.privy, wallet)
  }

  /**
   * The login's identity token: Privy's signed statement of who the user is and which wallets
   * they own. The relayer checks it before activating an account. Identity tokens must be
   * enabled in the Privy dashboard.
   */
  identityToken(): Promise<string | null> {
    return this.privy.getIdentityToken()
  }

  logout(): Promise<void> {
    return this.privy.auth.logout()
  }
}

/** Privy sign-in when `VITE_PRIVY_APP_ID` is set; otherwise the app offers NEAR wallets only. */
export function privyFromEnv(env: Record<string, unknown> = import.meta.env): PrivySession | null {
  const appId = env.VITE_PRIVY_APP_ID
  return typeof appId === 'string' && appId ? new PrivySession(appId) : null
}
