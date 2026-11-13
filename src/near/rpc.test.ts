import { Account, KeyPairEd25519, type Provider } from 'near-api-js'
import { InternalRpcError, InvalidNonceError, NotEnoughBalanceError, TransactionTimeoutError } from 'near-api-js/rpc-errors'
import { describe, expect, it } from 'vitest'
import { failoverProvider, parseRpcUrls } from './rpc'

/** A stand-in endpoint whose `viewBlock` answers with each of `results` in turn (an Error is thrown). */
function endpoint(...results: unknown[]): Provider & { calls: number } {
  const p = {
    calls: 0,
    async viewBlock() {
      const r = results[Math.min(p.calls++, results.length - 1)]
      if (r instanceof Error) throw r
      return r
    },
  }
  return p as unknown as Provider & { calls: number }
}

describe('failover provider', () => {
  it('moves to the next endpoint when one is down', async () => {
    const down = endpoint(new TypeError('fetch failed'))
    const up = endpoint({ header: { height: 7 } })
    expect(await failoverProvider([down, up]).viewBlock({ finality: 'final' })).toEqual({ header: { height: 7 } })
    expect([down.calls, up.calls]).toEqual([1, 1])
  })

  it("passes the chain's answer through instead of asking every endpoint", async () => {
    const refusing = endpoint(new NotEnoughBalanceError(1n, 2n, 'player.testnet', 'tx', 'block'))
    const other = endpoint({ header: { height: 7 } })
    await expect(failoverProvider([refusing, other]).viewBlock({ finality: 'final' })).rejects.toBeInstanceOf(NotEnoughBalanceError)
    expect(other.calls).toBe(0)
  })

  it('treats node-side failures as the endpoint failing', async () => {
    for (const e of [new InternalRpcError('boom'), new TransactionTimeoutError()]) {
      const a = endpoint(e)
      const b = endpoint({ header: { height: 1 } })
      expect(await failoverProvider([a, b]).viewBlock({ finality: 'final' })).toEqual({ header: { height: 1 } })
    }
  })

  it('throws the last endpoint error when every endpoint is down', async () => {
    await expect(failoverProvider([endpoint(new TypeError('a')), endpoint(new TypeError('b'))]).viewBlock({ finality: 'final' })).rejects.toThrow('b')
  })

  it('sticks with the endpoint that last worked', async () => {
    const flaky = endpoint(new TypeError('down'), { header: { height: 2 } })
    const steady = endpoint({ header: { height: 1 } })
    const p = failoverProvider([flaky, steady])
    await p.viewBlock({ finality: 'final' })
    await p.viewBlock({ finality: 'final' })
    expect([flaky.calls, steady.calls]).toEqual([1, 2])
  })

  it("lets Account see InvalidNonce, so it refreshes its nonce and retries (M12's stuck relayer)", async () => {
    let sends = 0
    let nonceReads = 0
    const chain = {
      async viewAccessKey() {
        nonceReads++
        return { nonce: nonceReads === 1 ? 5n : 9n, permission: 'FullAccess', block_height: 1, block_hash: '11111111111111111111111111111111' }
      },
      async viewBlock() {
        return { header: { hash: '11111111111111111111111111111111', height: 1 } }
      },
      async sendTransactionUntil(tx: { transaction: { nonce: bigint } }) {
        sends++
        if (tx.transaction.nonce <= 9n) throw new InvalidNonceError(9, Number(tx.transaction.nonce), 'tx', 'block')
        return { status: { SuccessValue: '' }, transaction_outcome: {}, receipts_outcome: [] }
      },
    }
    const account = new Account('relayer.testnet', failoverProvider([chain as unknown as Provider]), KeyPairEd25519.fromRandom().toString())
    await account.signAndSendTransaction({ receiverId: 'x.testnet', actions: [] })
    expect(sends).toBe(2)
    expect(nonceReads).toBe(2)
  })
})

describe('RPC URL list', () => {
  it('keeps the URLs in order, trimmed', () => {
    expect(parseRpcUrls(' https://a.example , https://b.example/rpc')).toEqual(['https://a.example', 'https://b.example/rpc'])
  })

  it('refuses a URL listed twice, however it is written', () => {
    for (const list of ['https://a.example,https://a.example', 'https://a.example, https://a.example ', 'https://a.example,https://a.example/', 'https://a.example,HTTPS://A.EXAMPLE:443/']) {
      expect(() => parseRpcUrls(list), list).toThrow(/twice/)
    }
  })

  it('refuses an empty entry or something that is not a URL', () => {
    for (const list of ['https://a.example,', 'https://a.example,,https://b.example', 'a.example']) expect(() => parseRpcUrls(list), list).toThrow(/Not an RPC URL/)
  })
})
