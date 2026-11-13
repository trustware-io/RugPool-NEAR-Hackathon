// The hosted Privy executor (public/privy-near-connect-executor-0.0.8-patched.js) runs in
// near-connect's sandboxed iframe. These tests run it against a stand-in for that iframe's
// window: the sign page's messages arrive relayed from `window.parent`; a forged one arrives
// from any other window holding a reference to the iframe.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const EXECUTOR = new URL('../../public/privy-near-connect-executor-0.0.8-patched.js', import.meta.url)

interface Wallet {
  signIn(data: object): Promise<Array<{ accountId: string }>>
  signAndSendTransaction(params: object): Promise<unknown>
  getAccounts(data: object): Promise<Array<{ accountId: string }>>
}

/** Loads the executor into a fake sandbox window; `post` delivers a message from `from`. */
function load() {
  const parent = {}
  const attacker = {}
  const stored = new Map<string, string>()
  const target = new EventTarget()
  let wallet: Wallet | undefined
  const win = Object.assign(target, {
    parent,
    selector: {
      ready: (w: Wallet) => (wallet = w),
      open: () => ({ windowIdPromise: Promise.resolve('panel-1'), closed: false, postMessage: () => {}, close: () => {} }),
      storage: { get: async (k: string) => stored.get(k), set: async (k: string, v: string) => void stored.set(k, v), remove: async (k: string) => void stored.delete(k) },
    },
  })
  // Our own repo file, run the way near-connect runs it: as a script with `window` in scope.
  new Function('window', readFileSync(EXECUTOR, 'utf8'))(win)
  const post = (from: object, data: object) => target.dispatchEvent(Object.assign(new Event('message'), { source: from, data }))
  const result = (r: unknown) => ({ source: 'privy-near-connect', type: 'RESULT', result: r })
  return { wallet: Object.assign(wallet!, { manifest: { metadata: { signPageURL: 'http://localhost:5173/privy.html#privy-sign' } } }), parent, attacker, post, result }
}

describe('hosted Privy executor', () => {
  it('ignores a RESULT that does not come from the parent page', async () => {
    const { wallet, parent, attacker, post, result } = load()
    const signIn = wallet.signIn({})
    post(attacker, result([{ accountId: 'attacker.testnet' }]))
    post(parent, result([{ accountId: 'player.testnet' }]))
    await expect(signIn).resolves.toEqual([{ accountId: 'player.testnet' }])
    await expect(wallet.getAccounts({})).resolves.toEqual([{ accountId: 'player.testnet' }])
  })

  it('refuses a sign-in result without a valid account id', async () => {
    const { wallet, parent, post, result } = load()
    for (const bad of [[], [{}], [{ accountId: 'Not An Account' }], { accountId: 'player.testnet' }, null]) {
      const signIn = wallet.signIn({})
      post(parent, result(bad))
      await expect(signIn).rejects.toThrow('malformed result')
    }
    await expect(wallet.getAccounts({})).resolves.toEqual([])
  })

  it('refuses a transaction result that is not an object', async () => {
    const { wallet, parent, post, result } = load()
    const tx = wallet.signAndSendTransaction({ receiverId: 'pool2.testnet', actions: [] })
    post(parent, result('ok'))
    await expect(tx).rejects.toThrow('malformed result')
  })

  it('accepts an implicit account and a transaction outcome from the parent page', async () => {
    const { wallet, parent, post, result } = load()
    const implicit = '9b7f2514f67202a2b468ad93e037664d59601d351ea0c296dc844372f7f985b1'
    const signIn = wallet.signIn({})
    post(parent, result([{ accountId: implicit, publicKey: 'ed25519:abc' }]))
    await expect(signIn).resolves.toEqual([{ accountId: implicit, publicKey: 'ed25519:abc' }])
    const tx = wallet.signAndSendTransaction({ receiverId: 'pool2.testnet', actions: [] })
    post(parent, result({ status: { SuccessValue: '' } }))
    await expect(tx).resolves.toEqual({ status: { SuccessValue: '' } })
  })
})
