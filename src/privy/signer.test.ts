// PrivyNearSigner turns near-api-js signing into Privy `rawSign` calls. Here rawSign is stood in
// by a local ed25519 key, so the test checks the plumbing around it: the hash Privy is asked to
// sign, the hex signature coming back, and the public key derived from the implicit account.

import { KeyPairEd25519, actions, createTransaction } from 'near-api-js'
import { describe, expect, it, vi } from 'vitest'
import { PrivyNearSigner } from './signer'

const key = KeyPairEd25519.fromRandom()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const implicit = hex(key.getPublicKey().data)
const asked: string[] = []

vi.mock('@privy-io/js-sdk-core', () => ({
  rawSign: async (_privy: unknown, _sign: unknown, { wallet_id, params }: { wallet_id: string; params: { hash: string } }) => {
    expect(wallet_id).toBe('wallet-1')
    asked.push(params.hash)
    const bytes = Uint8Array.from(params.hash.slice(2).match(/../g)!, (b) => parseInt(b, 16))
    return { data: { signature: `0x${hex(key.sign(bytes).signature)}`, encoding: 'hex' } }
  },
}))

describe('PrivyNearSigner', () => {
  const signer = new PrivyNearSigner({} as never, { id: 'wallet-1', address: implicit })

  it('derives the public key from the implicit account', async () => {
    expect((await signer.getPublicKey()).toString()).toBe(key.getPublicKey().toString())
  })

  it('signs a transaction that verifies against the account key', async () => {
    const tx = createTransaction(implicit, key.getPublicKey(), 'pool2.testnet', 1n, [actions.transfer(1n)], new Uint8Array(32))
    const { txHash, signedTransaction } = await signer.signTransaction(tx)
    expect(asked.at(-1)).toBe(`0x${hex(txHash)}`)
    expect(key.verify(txHash, signedTransaction.signature.data)).toBe(true)
  })
})
