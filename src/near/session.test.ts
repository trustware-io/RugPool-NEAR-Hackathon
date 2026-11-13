import { describe, expect, it } from 'vitest'
import { KeyPairSigner, buildDelegateAction, actions, encodeSignedDelegate, KeyPairEd25519, type Provider } from 'near-api-js'
import { fromWire, toWire } from './relayWire'
import { relay, SessionKeys, SessionSigner, type KeyStore } from './session'

function memoryStore(): KeyStore {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

/** Just the two provider calls the signer makes. */
function fakeProvider(chainNonce: bigint, height: number): Provider {
  return {
    viewAccessKey: async () => ({ nonce: chainNonce, permission: 'FullAccess' }),
    viewBlock: async () => ({ header: { height } }),
  } as unknown as Provider
}

describe('relay wire format', () => {
  it('rebuilds the exact bytes the session key signed', async () => {
    const key = KeyPairEd25519.fromRandom()
    const delegateAction = buildDelegateAction({
      senderId: 'bob.testnet',
      receiverId: 'pool.testnet',
      actions: [actions.functionCall('challenge', { max_price: '5150000' }, 100_000_000_000_000n, 0n)],
      nonce: 42n,
      maxBlockHeight: 1_100n,
      publicKey: key.getPublicKey(),
    })
    const { signedDelegate } = await new KeyPairSigner(key).signDelegateAction(delegateAction)
    const wire = JSON.parse(JSON.stringify(toWire(signedDelegate)))
    expect(encodeSignedDelegate(fromWire(wire))).toEqual(encodeSignedDelegate(signedDelegate))
  })
})

describe('SessionKeys', () => {
  it('keeps one key per contract and account', () => {
    const keys = new SessionKeys(memoryStore())
    const k = keys.create()
    keys.save('pool.testnet', 'bob.testnet', k)
    expect(keys.load('pool.testnet', 'bob.testnet')?.getPublicKey().toString()).toBe(k.getPublicKey().toString())
    expect(keys.load('pool.testnet', 'alice.testnet')).toBeNull()
    keys.forget('pool.testnet', 'bob.testnet')
    expect(keys.load('pool.testnet', 'bob.testnet')).toBeNull()
  })
})

describe('SessionSigner', () => {
  it('signs zero-deposit calls with fresh nonces, even before the chain catches up', async () => {
    const signer = new SessionSigner(fakeProvider(7n, 1_000), 'bob.testnet', KeyPairEd25519.fromRandom())
    const a = await signer.sign('pool.testnet', 'challenge', { max_price: '1' }, 100)
    const b = await signer.sign('pool.testnet', 'claim', {}, 60)
    expect([a.nonce, b.nonce]).toEqual(['8', '9'])
    expect(a.maxBlockHeight).toBe('1100')
    expect(a.actions).toEqual([{ type: 'call', methodName: 'challenge', args: btoa('{"max_price":"1"}'), gas: '100000000000000', deposit: '0' }])
  })
})

describe('relay', () => {
  it('posts the delegate and returns the outcome', async () => {
    let sent: { url: string; body: unknown } | null = null
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) }
      return new Response(JSON.stringify({ outcome: { status: { SuccessValue: '' } } }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await relay('http://relayer.test/', { senderId: 'bob.testnet' } as never, fetcher)
    expect(out).toEqual({ status: { SuccessValue: '' } })
    expect(sent).toEqual({ url: 'http://relayer.test/relay', body: { senderId: 'bob.testnet' } })
  })

  it('surfaces the relayer refusal', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: 'receiver usdc.testnet is not pool.testnet' }), { status: 400 })) as unknown as typeof fetch
    await expect(relay('http://relayer.test', {} as never, fetcher)).rejects.toThrow(/receiver/)
  })
})
