// NEAR testnet plumbing shared by ContractStore and the direct deposit service: one wallet
// connector, one RPC provider, and outcome parsing that turns contract panics
// ("CODE: message") into GameErrors.

import { NearConnector } from '@hot-labs/near-connect'
import { Account, actions, type Provider, type Signer } from 'near-api-js'
import { GameError, type GameErrorCode } from '../game/types'
import { GAME_METHODS, SESSION_KEY_ALLOWANCE } from './relayPolicy'
import { rpcProvider } from './rpc'
import { relay, sessionKeyChange, SessionKeys, sessionKeysOn, SessionSigner, signAccountDelegate, type KeyStore } from './session'

export interface NearConfig {
  rugpool: string
  usdc: string
  /** Tried in order; the next one takes over when one fails or rate-limits. */
  rpcUrls: string[]
  /** With a relayer, sign-in adds a session key and game actions are relayed: no popups, no gas. */
  relayerUrl?: string
}

const DEFAULT_RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']

export function nearConfigFromEnv(env: Record<string, unknown> = import.meta.env): NearConfig {
  const { VITE_RUGPOOL_CONTRACT: rugpool, VITE_USDC_CONTRACT: usdc, VITE_NEAR_RPC: rpc, VITE_RELAYER_URL: relayerUrl } = env
  if (typeof rugpool !== 'string' || !rugpool || typeof usdc !== 'string' || !usdc) {
    throw new Error('VITE_STORE=contract needs VITE_RUGPOOL_CONTRACT and VITE_USDC_CONTRACT.')
  }
  const rpcUrls = typeof rpc === 'string' ? rpc.split(',').map((u) => u.trim()).filter(Boolean) : []
  return { rugpool, usdc, rpcUrls: rpcUrls.length ? rpcUrls : DEFAULT_RPCS, ...(typeof relayerUrl === 'string' && relayerUrl ? { relayerUrl } : {}) }
}

const GAME_CODES: readonly GameErrorCode[] = [
  'NOT_CONNECTED',
  'COURT_TOO_SMALL',
  'ALREADY_KING',
  'ROUND_CLOSED',
  'PRICE_MOVED',
  'INSUFFICIENT_BALANCE',
  'COOLDOWN',
  'NOTHING_TO_WITHDRAW',
  'NOTHING_TO_CLAIM',
  'INVALID_AMOUNT',
  'PAUSED',
  'CAP_REACHED',
  'COURT_FULL',
  'BUY_LOCKED',
  'UNTRUSTED_RELAYER',
]

/** Turns a contract panic anywhere in `raw` into a GameError; anything else becomes a plain Error. */
export function toActionError(raw: unknown): Error {
  if (raw instanceof GameError) return raw
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : JSON.stringify(raw)
  const m = /panicked: ([A-Z_]+): ([^"\\]+)/.exec(text)
  if (!m) return raw instanceof Error ? raw : new Error(text)
  const [, code, message] = m as unknown as [string, string, string]
  return (GAME_CODES as readonly string[]).includes(code) ? new GameError(code as GameErrorCode, message) : new Error(message)
}

interface Outcome {
  status: unknown
  receipts_outcome?: Array<{ id?: string; outcome?: { executor_id?: string; status?: unknown } }>
}

function isOutcome(v: unknown): v is Outcome {
  return typeof v === 'object' && v !== null && 'status' in v
}

function failureOf(status: unknown): unknown {
  return typeof status === 'object' && status !== null && 'Failure' in status ? (status as { Failure: unknown }).Failure : undefined
}

/** The first failed receipt, e.g. a refused `ft_on_transfer` behind a successful `ft_transfer_call`. */
export function receiptFailure(outcome: unknown): Error | null {
  if (!isOutcome(outcome)) return null
  for (const r of outcome.receipts_outcome ?? []) {
    const f = failureOf(r.outcome?.status)
    if (f !== undefined) return toActionError(f)
  }
  return null
}

/**
 * A relayed action is the relayer's transaction: its `status` is the outer Delegate's, which
 * succeeds even when the game call inside it is refused. This returns the outcome with the game
 * call's own final status instead: its receipt on `receiverId`, followed through any promise
 * (claim and withdraw return their result from the payout callback).
 */
export function gameOutcome(outcome: unknown, receiverId: string): unknown {
  if (!isOutcome(outcome)) return outcome
  const receipts = outcome.receipts_outcome ?? []
  let status = receipts.find((r) => r.outcome?.executor_id === receiverId)?.outcome?.status
  if (status === undefined) return outcome
  for (let hops = 0; typeof status === 'object' && status !== null && 'SuccessReceiptId' in status && hops < receipts.length; hops++) {
    const next = (status as { SuccessReceiptId: unknown }).SuccessReceiptId
    status = receipts.find((r) => r.id === next)?.outcome?.status
  }
  return { ...outcome, status }
}

/** Throws if the transaction failed; otherwise returns its decoded JSON return value. */
export function returnValue(outcome: unknown): unknown {
  if (!isOutcome(outcome)) throw new Error('The wallet returned no transaction outcome.')
  const failure = failureOf(outcome.status)
  if (failure !== undefined) throw toActionError(failure)
  const s = outcome.status
  if (typeof s === 'object' && s !== null && 'SuccessValue' in s) {
    const b64 = (s as { SuccessValue: unknown }).SuccessValue
    if (typeof b64 === 'string' && b64) return JSON.parse(atob(b64))
  }
  return undefined
}

export interface CallOptions {
  tgas: number
  /** Attached yoctoNEAR. */
  deposit?: string
}

export class Near {
  readonly config: NearConfig
  readonly connector: NearConnector
  readonly provider: Provider
  private readonly sessions: SessionKeys
  private session: { accountId: string; signer: SessionSigner; active: boolean } | null = null
  /** After `signInWith`: the account and the page's signer, used instead of a wallet. */
  private pageAccount: Account | null = null
  private pageSigner: Signer | null = null

  constructor(config: NearConfig, store: KeyStore = localStorage) {
    this.config = config
    this.connector = new NearConnector({ network: 'testnet', features: { signAndSendTransaction: true, testnet: true } })
    this.provider = rpcProvider(config.rpcUrls)
    this.sessions = new SessionKeys(store)
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const v = await this.provider.callFunction<T & object>({ contractId, method, args })
    if (v === undefined) throw new Error(`${contractId}.${method} returned nothing.`)
    return v
  }

  /** Timestamp of the latest final block, in ms. */
  async chainNowMs(): Promise<number> {
    const b = await this.provider.viewBlock({ finality: 'final' })
    return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n)
  }

  /** The account restored from a previous session, if any. */
  async restoredAccount(): Promise<string | null> {
    try {
      const { accounts } = await this.connector.getConnectedWallet()
      const id = accounts[0]?.accountId ?? null
      if (id) this.useSession(id)
      return id
    } catch {
      return null
    }
  }

  /**
   * With a relayer, the wallet is asked to add a session key limited to the game's play methods.
   * `walletId` skips near-connect's wallet picker.
   */
  async connect(walletId?: string): Promise<string> {
    const key = this.config.relayerUrl ? this.sessions.create() : null
    const wallet = await this.connector.connect({
      ...(walletId ? { walletId } : {}),
      ...(key
        ? {
            addFunctionCallKey: {
              contractId: this.config.rugpool,
              publicKey: key.getPublicKey().toString(),
              allowMethods: { anyMethod: false, methodNames: [...GAME_METHODS] },
              // Not near-connect's default 0.25 NEAR: a key that can pay its own gas skips the
              // relayer's expiry and the contract's trusted-relayer check. Wallets may ignore it.
              gasAllowance: { amount: SESSION_KEY_ALLOWANCE.toString(), kind: 'limited' },
            },
          }
        : {}),
    })
    const [account] = await wallet.getAccounts({ network: 'testnet' })
    if (!account) throw new Error('The wallet did not return an account.')
    if (key) {
      this.sessions.save(this.config.rugpool, account.accountId, key)
      this.useSession(account.accountId)
    }
    return account.accountId
  }

  /**
   * Signs in `accountId` with a signer the page holds (a Privy wallet), with no wallet popup:
   * the relayer activates the account if it's new (proven by the login's identity token), then
   * relays a key change, signed here, that adds a session key and deletes any stale ones. A key
   * from an earlier sign-in that is still on the account is reused. The player pays nothing.
   */
  async signInWith(accountId: string, signer: Signer, identityToken: () => Promise<string | null>): Promise<'reused' | 'added'> {
    const relayerUrl = this.config.relayerUrl
    if (!relayerUrl) throw new Error('Sign-in with a session key needs VITE_RELAYER_URL.')
    const saved = this.sessions.load(this.config.rugpool, accountId)
    if (saved && (await this.relayOnlyKey(accountId, saved.getPublicKey().toString()))) {
      this.usePage(accountId, signer)
      return 'reused'
    }
    await this.activate(relayerUrl, accountId, identityToken)
    await this.addSessionKey(relayerUrl, accountId, signer)
    this.usePage(accountId, signer)
    return 'added'
  }

  /** Whether the key is on the account as a relay-only session key (older ones could pay gas). */
  private async relayOnlyKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      const k = await this.provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } })
      return typeof k.permission === 'object' && k.permission.FunctionCall.allowance === SESSION_KEY_ALLOWANCE.toString()
    } catch {
      return false
    }
  }

  /** Relays a key change, signed by the page, adding a new session key and deleting all others. */
  private async addSessionKey(relayerUrl: string, accountId: string, signer: Signer): Promise<void> {
    const key = this.sessions.create()
    const stale = await sessionKeysOn(this.provider, accountId, this.config.rugpool)
    const change = await signAccountDelegate(this.provider, signer, accountId, accountId, sessionKeyChange(this.config.rugpool, key.getPublicKey(), stale.slice(0, 8)))
    const failed = receiptFailure(await relay(relayerUrl, change))
    if (failed) throw failed
    this.sessions.save(this.config.rugpool, accountId, key)
  }

  /** Asks the relayer to activate the account (a no-op once it has been). */
  private async activate(relayerUrl: string, accountId: string, identityToken: () => Promise<string | null>): Promise<void> {
    const idToken = await identityToken()
    if (!idToken) throw new Error('Sign in again: the login has no identity token.')
    const res = await fetch(`${relayerUrl.replace(/\/$/, '')}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, accountId }) })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `The relayer answered ${res.status}.`)
    }
  }

  private usePage(accountId: string, signer: Signer): void {
    this.pageAccount = new Account(accountId, this.provider, signer)
    this.pageSigner = signer
    this.useSession(accountId)
  }

  /**
   * Signs out. After a page sign-in, the session key is deleted on chain first, through the
   * relayer, so a copy of it left in this browser is useless. If that fails the local key is
   * still forgotten, and the error is thrown so the app can say the key wasn't revoked.
   */
  async disconnect(): Promise<void> {
    const session = this.session
    const signer = this.pageSigner
    const relayerUrl = this.config.relayerUrl
    this.session = null
    this.pageAccount = null
    this.pageSigner = null
    if (session) this.sessions.forget(this.config.rugpool, session.accountId)
    if (!signer) return void (await this.connector.disconnect())
    if (!session || !relayerUrl) return
    const keys = await sessionKeysOn(this.provider, session.accountId, this.config.rugpool)
    if (keys.length === 0) return
    const failed = receiptFailure(await relay(relayerUrl, await signAccountDelegate(this.provider, signer, session.accountId, session.accountId, sessionKeyChange(this.config.rugpool, null, keys.slice(0, 8)))))
    if (failed) throw failed
  }

  private useSession(accountId: string): void {
    const key = this.config.relayerUrl ? this.sessions.load(this.config.rugpool, accountId) : null
    if (!key) return
    this.session = { accountId, signer: new SessionSigner(this.provider, accountId, key), active: false }
  }

  /**
   * Relays a game call signed with the session key, or returns null when there's no usable
   * session (no relayer, a wallet that didn't add the key, a deposit, another contract) so the
   * caller can ask the wallet instead.
   */
  async relayCall(receiverId: string, methodName: string, args: Record<string, unknown>, opts: CallOptions): Promise<unknown | null> {
    const s = this.session
    if (!s || !this.config.relayerUrl || receiverId !== this.config.rugpool || (opts.deposit ?? '0') !== '0') return null
    if (!(GAME_METHODS as readonly string[]).includes(methodName)) return null
    const relayerUrl = this.config.relayerUrl
    const send = async () => gameOutcome(await relay(relayerUrl, await this.session!.signer.sign(receiverId, methodName, args, opts.tgas)), receiverId)
    // After a page sign-in, a session key that expired, was deleted or never landed is replaced
    // through the relayer and the action retried once: never paid from the player's own NEAR.
    const page = this.pageSigner && this.pageAccount ? { signer: this.pageSigner, accountId: this.pageAccount.accountId } : null
    const renew = async () => {
      await this.addSessionKey(relayerUrl, page!.accountId, page!.signer)
      this.useSession(page!.accountId)
      this.session!.active = true
    }
    // Re-checked until it's seen on chain: the wallet's add-key transaction may still be landing.
    if (!s.active) s.active = await s.signer.isActive()
    if (!s.active) {
      if (!page) return null
      await renew().catch((e: unknown) => {
        throw toActionError(e)
      })
    }
    try {
      return await send()
    } catch (e) {
      if (!(e instanceof Error && /session key/.test(e.message))) throw toActionError(e)
      if (!page) {
        // The key was removed (or never added): stop relaying and let the wallet sign this one.
        s.active = false
        return null
      }
      try {
        await renew()
        return await send()
      } catch (again) {
        throw toActionError(again)
      }
    }
  }

  /**
   * Signs one function call with the connected wallet and returns the raw outcome. After
   * `signInWith`, the page's signer signs instead: the player's click on the action (say,
   * Deposit) is the approval.
   */
  async call(receiverId: string, methodName: string, args: Record<string, unknown>, opts: CallOptions): Promise<unknown> {
    // After a page sign-in, the player's USDC deposit is relayed too, so it needs no NEAR.
    if (this.pageSigner && this.pageAccount && this.config.relayerUrl && receiverId === this.config.usdc && methodName === 'ft_transfer_call') {
      try {
        const signed = await signAccountDelegate(this.provider, this.pageSigner, this.pageAccount.accountId, receiverId, [actions.functionCall(methodName, args, BigInt(opts.tgas) * 10n ** 12n, BigInt(opts.deposit ?? '0'))])
        return gameOutcome(await relay(this.config.relayerUrl, signed), receiverId)
      } catch (e) {
        throw toActionError(e)
      }
    }
    if (this.pageAccount) {
      // Play calls after a page sign-in only ever go through the relayer (relayCall).
      if (receiverId === this.config.rugpool) throw new Error('Your session ended. Sign in again to keep playing.')
      try {
        const action = actions.functionCall(methodName, args, BigInt(opts.tgas) * 10n ** 12n, BigInt(opts.deposit ?? '0'))
        return await this.pageAccount.signAndSendTransaction({ receiverId, actions: [action], throwOnFailure: false })
      } catch (e) {
        throw toActionError(e)
      }
    }
    const wallet = await this.connector.wallet()
    try {
      return await wallet.signAndSendTransaction({
        network: 'testnet',
        receiverId,
        actions: [{ type: 'FunctionCall', params: { methodName, args, gas: String(opts.tgas * 1e12), deposit: opts.deposit ?? '0' } }],
      })
    } catch (e) {
      throw toActionError(e)
    }
  }
}
