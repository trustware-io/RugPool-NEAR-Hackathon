// The app's sign-in, deposit and sign-out wiring against a fake RPC and relayer: which requests
// it makes, in which order, and what it signs. The real chain and relayer are exercised by
// scripts/e2e-slice.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyPairEd25519, KeyPairSigner } from 'near-api-js'
import { Near } from './near'
import type { WireDelegate } from './relayWire'

const RPC = 'http://rpc.test'
const RELAYER = 'http://relayer.test'
const POOL = 'pool.testnet'
const USDC = 'usdc.testnet'

/** Scripted relayer refusals, answered in order to game calls relayed to the pool. */
type Refusal = { status: number; error: string }

function fakeNetwork(stale: string[] = [], refusals: Refusal[] = [], allowance = '1') {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const relayed = (status: unknown = { SuccessValue: '' }) => ({ outcome: { status: { SuccessValue: '' }, receipts_outcome: [{ id: 'r1', outcome: { executor_id: 'x', status } }] } })
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    const respond = (v: unknown) => new Response(JSON.stringify(v), { status: 200 })
    if (url.startsWith(RELAYER)) {
      const path = new URL(url).pathname
      posts.push({ path, body })
      const refusal = path === '/relay' && body.receiverId === POOL ? refusals.shift() : undefined
      if (refusal) return new Response(JSON.stringify({ error: refusal.error }), { status: refusal.status })
      return respond(path === '/activate' ? { state: 'funded' } : relayed())
    }
    const { method, params } = body as { method: string; params: Record<string, unknown> }
    const result =
      method === 'block'
        ? { header: { height: 1_000, hash: '11111111111111111111111111111111', timestamp_nanosec: '0' } }
        : params.request_type === 'view_access_key_list'
          ? { block_height: 1, block_hash: '1', keys: stale.map((pk) => ({ public_key: pk, access_key: { nonce: 1, permission: { FunctionCall: { allowance: '1', receiver_id: POOL, method_names: [] } } } })) }
          : stale.includes(String(params.public_key))
            ? { block_height: 1, block_hash: '1', nonce: 41, permission: { FunctionCall: { allowance, receiver_id: POOL, method_names: [] } } }
            : { block_height: 1, block_hash: '1', nonce: 41, permission: 'FullAccess' }
    return respond({ jsonrpc: '2.0', id: body.id, result })
  })
  vi.stubGlobal('fetch', fetch)
  return { posts }
}

function setup(stale: string[] = [], refusals: Refusal[] = [], allowance = '1') {
  const net = fakeNetwork(stale, refusals, allowance)
  const store = new Map<string, string>()
  const near = new Near({ rugpool: POOL, usdc: USDC, rpcUrls: [RPC], relayerUrl: RELAYER }, { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) })
  const wallet = KeyPairEd25519.fromRandom()
  const account = Buffer.from(wallet.getPublicKey().data).toString('hex')
  return { ...net, near, store, account, signer: new KeyPairSigner(wallet) }
}

afterEach(() => vi.unstubAllGlobals())

describe('page sign-in through the relayer', () => {
  it('activates the account with the identity token, then relays a key change adding a session key and deleting stale ones', async () => {
    const stale = [KeyPairEd25519.fromRandom().getPublicKey().toString(), KeyPairEd25519.fromRandom().getPublicKey().toString()]
    const s = setup(stale)
    expect(await s.near.signInWith(s.account, s.signer, async () => 'id-token')).toBe('added')
    expect(s.posts.map((p) => p.path)).toEqual(['/activate', '/relay'])
    expect(s.posts[0]?.body).toEqual({ idToken: 'id-token', accountId: s.account })
    const change = s.posts[1]?.body as unknown as WireDelegate
    expect(change.receiverId).toBe(s.account)
    expect(change.nonce).toBe('42')
    expect(change.actions.map((a) => a.type)).toEqual(['addKey', 'deleteKey', 'deleteKey'])
    expect(change.actions.filter((a) => a.type === 'deleteKey').map((a) => a.publicKey)).toEqual(stale)
    const added = change.actions[0] as Extract<WireDelegate['actions'][number], { type: 'addKey' }>
    expect([added.receiverId, added.allowance]).toEqual([POOL, '1'])
    expect([...s.store.keys()]).toEqual([`rugpool:session:${POOL}:${s.account}`])
  })

  it('stops before relaying anything without an identity token', async () => {
    const s = setup()
    await expect(s.near.signInWith(s.account, s.signer, async () => null)).rejects.toThrow(/identity token/)
    expect(s.posts).toEqual([])
    expect(s.store.size).toBe(0)
  })

  it("relays the player's deposit instead of asking them to pay gas", async () => {
    const s = setup()
    await s.near.signInWith(s.account, s.signer, async () => 'id-token')
    await s.near.call(USDC, 'ft_transfer_call', { receiver_id: POOL, amount: '5000000', msg: '{"action":"join"}' }, { tgas: 100, deposit: '1' })
    const deposit = s.posts[2]?.body as unknown as WireDelegate
    expect(s.posts[2]?.path).toBe('/relay')
    expect([deposit.receiverId, deposit.actions[0]?.type]).toEqual([USDC, 'call'])
  })

  it('signs out by deleting the session keys on chain through the relayer, and forgets the local one', async () => {
    const onChain = KeyPairEd25519.fromRandom().getPublicKey().toString()
    const s = setup([onChain])
    await s.near.signInWith(s.account, s.signer, async () => 'id-token')
    await s.near.disconnect()
    const signOut = s.posts.at(-1)?.body as unknown as WireDelegate
    expect(signOut.actions).toEqual([{ type: 'deleteKey', publicKey: onChain }])
    expect(s.store.size).toBe(0)
  })

  it('replaces an expired session key through the relayer and retries, never charging the player', async () => {
    const s = setup([], [{ status: 400, error: 'session key expired; sign in again' }])
    await s.near.signInWith(s.account, s.signer, async () => 'id-token')
    await s.near.relayCall(POOL, 'claim', {}, { tgas: 50 })
    const relays = s.posts.filter((p) => p.path === '/relay').map((p) => (p.body as unknown as WireDelegate).receiverId)
    // sign-in key change, the refused claim, the replacement key change, the retried claim
    expect(relays).toEqual([s.account, POOL, s.account, POOL])
  })

  it("doesn't reuse a saved key that can pay its own gas: it is replaced and deleted", async () => {
    const old = KeyPairEd25519.fromRandom()
    const s = setup([old.getPublicKey().toString()], [], '250000000000000000000000')
    s.store.set(`rugpool:session:${POOL}:${s.account}`, old.toString())
    expect(await s.near.signInWith(s.account, s.signer, async () => 'id-token')).toBe('added')
    const change = s.posts.at(-1)?.body as unknown as WireDelegate
    expect(change.actions.map((a) => a.type)).toEqual(['addKey', 'deleteKey'])
    expect((change.actions[1] as { publicKey: string }).publicKey).toBe(old.getPublicKey().toString())
  })

  it('never signs a play call directly after a page sign-in', async () => {
    const s = setup()
    await s.near.signInWith(s.account, s.signer, async () => 'id-token')
    await expect(s.near.call(POOL, 'challenge', { max_price: '5' }, { tgas: 100 })).rejects.toThrow(/Sign in again/)
  })
})
