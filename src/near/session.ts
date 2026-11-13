// The browser's session key: a key added at sign-in that can only call the game's play methods.
// Game actions are signed with it as delegate actions (NEP-366) and handed to the relayer, which
// pays the gas, so playing needs no wallet popup and no NEAR. Anyone who reads the key (say,
// through an XSS) can spend the game balance on tickets, or trigger claims and withdrawals, which
// only ever pay the player's own account. It can't attach a deposit and only reaches the game
// contract. Its allowance of 1 yoctoNEAR can't pay for a transaction, so it works only through
// the relayer, which refuses it once it's older than the session lifetime; sign-out deletes it.
//
// Deposits and key changes are signed with the account's own key (the player's Privy wallet, in
// the page) and relayed too, so the player never pays gas.

import { KeyPair, KeyPairEd25519, KeyPairSigner, PublicKey, actions, buildDelegateAction, type Action, type KeyPairString, type Provider, type Signer } from 'near-api-js'
import { GAME_METHODS, SESSION_KEY_ALLOWANCE } from './relayPolicy'
import { toWire, type WireDelegate } from './relayWire'

export interface KeyStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const slot = (contract: string, account: string) => `rugpool:session:${contract}:${account}`

export class SessionKeys {
  private readonly store: KeyStore

  constructor(store: KeyStore) {
    this.store = store
  }

  create(): KeyPairEd25519 {
    return KeyPairEd25519.fromRandom()
  }

  save(contract: string, account: string, key: KeyPair): void {
    this.store.setItem(slot(contract, account), key.toString())
  }

  load(contract: string, account: string): KeyPair | null {
    const s = this.store.getItem(slot(contract, account))
    return s ? KeyPair.fromString(s as KeyPairString) : null
  }

  forget(contract: string, account: string): void {
    this.store.removeItem(slot(contract, account))
  }
}

/** How long a signed action stays valid, in blocks (about two minutes). */
const TTL_BLOCKS = 100n

/**
 * Signs function calls with a session key. Nonces are tracked locally so several actions can
 * be signed before the first lands; the relayer submits them in nonce order.
 */
export class SessionSigner {
  private readonly provider: Provider
  private readonly accountId: string
  private readonly key: KeyPair
  private nonce = 0n

  constructor(provider: Provider, accountId: string, key: KeyPair) {
    this.provider = provider
    this.accountId = accountId
    this.key = key
  }

  /** Whether the key is on the account, i.e. the wallet really added it at sign-in. */
  async isActive(): Promise<boolean> {
    try {
      await this.provider.viewAccessKey({ accountId: this.accountId, publicKey: this.key.getPublicKey(), finalityQuery: { finality: 'optimistic' } })
      return true
    } catch {
      return false
    }
  }

  async sign(receiverId: string, method: string, args: Record<string, unknown>, tgas: number, guard?: () => void): Promise<WireDelegate> {
    const [access, block] = await Promise.all([
      this.provider.viewAccessKey({ accountId: this.accountId, publicKey: this.key.getPublicKey(), finalityQuery: { finality: 'optimistic' } }),
      this.provider.viewBlock({ finality: 'final' }),
    ])
    if (guard) {
      guard()
      const p = access.permission
      if (typeof p !== 'object' || p.FunctionCall.receiver_id !== receiverId || p.FunctionCall.allowance !== SESSION_KEY_ALLOWANCE.toString() || !p.FunctionCall.method_names.includes(method)) throw Error('Existing session permission is unavailable. Sign in explicitly; no automatic renewal.')
    }
    this.nonce = (access.nonce > this.nonce ? access.nonce : this.nonce) + 1n
    const delegateAction = buildDelegateAction({
      senderId: this.accountId,
      receiverId,
      actions: [actions.functionCall(method, args, BigInt(tgas) * 1_000_000_000_000n, 0n)],
      nonce: this.nonce,
      maxBlockHeight: BigInt(block.header.height) + TTL_BLOCKS,
      publicKey: this.key.getPublicKey(),
    })
    const { signedDelegate } = await new KeyPairSigner(this.key).signDelegateAction(delegateAction)
    return toWire(signedDelegate)
  }
}

/**
 * Signs a delegate action with the account's own full-access key: a deposit or a session key
 * change. It takes the key's next nonce, so sign and relay one before signing the next.
 */
export async function signAccountDelegate(provider: Provider, signer: Signer, accountId: string, receiverId: string, acts: Action[]): Promise<WireDelegate> {
  const publicKey = await signer.getPublicKey()
  const [access, block] = await Promise.all([
    provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } }),
    provider.viewBlock({ finality: 'final' }),
  ])
  const delegateAction = buildDelegateAction({
    senderId: accountId,
    receiverId,
    actions: acts,
    nonce: access.nonce + 1n,
    maxBlockHeight: BigInt(block.header.height) + TTL_BLOCKS,
    publicKey,
  })
  const { signedDelegate } = await signer.signDelegateAction(delegateAction)
  return toWire(signedDelegate)
}

/** The account's session keys for `pool`: every function-call key that calls it. */
export async function sessionKeysOn(provider: Provider, accountId: string, pool: string): Promise<PublicKey[]> {
  const { keys } = await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: 'optimistic' } })
  return keys
    .filter((k) => typeof k.access_key.permission === 'object' && k.access_key.permission.FunctionCall.receiver_id === pool)
    .map((k) => PublicKey.fromString(k.public_key))
}

/** Adds `key` as the session key for `pool` and deletes `stale` ones, in one relayed change. */
export function sessionKeyChange(pool: string, key: PublicKey | null, stale: PublicKey[]): Action[] {
  return [
    ...(key ? [actions.addFunctionCallAccessKey(key, pool, [...GAME_METHODS], SESSION_KEY_ALLOWANCE)] : []),
    ...stale.map((k) => actions.deleteKey(k)),
  ]
}

/** Sends a signed action to the relayer and returns the transaction outcome it reports. */
export async function relay(url: string, delegate: WireDelegate, fetcher: typeof fetch = fetch): Promise<unknown> {
  const res = await fetcher(`${url.replace(/\/$/, '')}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(delegate),
  })
  const body = (await res.json().catch(() => ({}))) as { outcome?: unknown; error?: string }
  if (!res.ok || body.outcome === undefined) throw new Error(body.error ?? `The relayer answered ${res.status}.`)
  return body.outcome
}
