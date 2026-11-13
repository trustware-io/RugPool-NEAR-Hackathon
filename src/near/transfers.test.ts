import { KeyPair, type Account, type Provider } from 'near-api-js'
import { UnknownTransactionError } from 'near-api-js/rpc-errors'
import { describe, expect, it } from 'vitest'
import { classifyAttempt, nearTransfers, type Lookup, type TransferAttempt } from './transfers'

const LIMITS = { validityBlocks: 100n, historyBlocks: 1_000n, retentionMarginBlocks: 50n }
const attempt = { nonce: 50n, height: 1_000n }
const verdict = (lookup: Lookup, keyNonce = 49n, height = 1_010n, head = height, earliest: bigint | null = 0n) => classifyAttempt(attempt, { earliest, keyNonce, keyHeight: height, lookup, head }, LIMITS)
const at = (...a: Parameters<typeof verdict>) => {
  const { outcome, landable } = verdict(...a)
  return { outcome, landable }
}

describe('settling a transfer from the chain', () => {
  it('takes a final outcome as it is', () => {
    expect(at('succeeded', 99n, 5_000n)).toEqual({ outcome: 'succeeded', landable: false })
    expect(at('failed')).toEqual({ outcome: 'failed', landable: false })
  })

  it('treats a transaction the chain is still working on as unknown', () => {
    expect(at('pending', 99n, 2_000n)).toEqual({ outcome: 'unknown', landable: false })
  })

  it('a missing transaction that could still land is unknown, and worth rebroadcasting', () => {
    expect(at('missing')).toEqual({ outcome: 'unknown', landable: true })
    expect(at('missing', 49n, 1_100n)).toEqual({ outcome: 'unknown', landable: true })
  })

  it('a missing transaction is failed once its nonce is used', () => {
    expect(at('missing', 50n)).toEqual({ outcome: 'failed', landable: false })
    expect(at('missing', 80n)).toEqual({ outcome: 'failed', landable: false })
  })

  it('a missing transaction whose nonce is unused is failed once past the validity period (plus a margin)', () => {
    expect(at('missing', 49n, 1_110n)).toEqual({ outcome: 'unknown', landable: true })
    expect(at('missing', 49n, 1_111n)).toEqual({ outcome: 'failed', landable: false })
    // An unused nonce proves it never landed, however old: no lookup is needed.
    expect(at('missing', 49n, 50_000n)).toEqual({ outcome: 'failed', landable: false })
  })

  it('judges expiry at the height the nonce was read at, not a later head', () => {
    // The nonce was read before expiry; the head has moved past it since. The transfer could have
    // landed in between, so this proves nothing.
    expect(at('missing', 49n, 1_110n, 1_500n)).toEqual({ outcome: 'unknown', landable: true })
  })

  it('never calls a missing transaction with a used nonce failed once the RPC may have dropped it', () => {
    expect(at('missing', 80n, 2_001n)).toEqual({ outcome: 'unknown', landable: false })
    expect(at('missing', 80n, 2_000n)).toEqual({ outcome: 'failed', landable: false })
  })

  it("trusts \"no record\" only well inside the history the endpoint says it holds", () => {
    // The transfer's reference block is 1000; the margin is 50.
    expect(at('missing', 80n, 1_010n, 1_010n, 950n)).toEqual({ outcome: 'failed', landable: false })
    expect(at('missing', 80n, 1_010n, 1_010n, 951n)).toEqual({ outcome: 'unknown', landable: false })
    expect(at('missing', 80n, 1_010n, 1_010n, null)).toEqual({ outcome: 'unknown', landable: false })
    // An unused nonce needs no history: it never landed.
    expect(at('missing', 49n, 1_111n, 1_111n, 1_100n)).toEqual({ outcome: 'failed', landable: false })
  })
})

describe('which verdicts need a second endpoint', () => {
  it('a failure resting on a lookup needs confirming; one read from a single response does not', () => {
    expect(verdict('failed').confirm).toBe(true)
    expect(verdict('missing', 80n).confirm).toBe(true)
    expect(verdict('missing', 49n, 1_111n).confirm).toBe(false)
    expect(verdict('succeeded').confirm).toBe(false)
  })
})

describe('nearTransfers.status', () => {
  const relayer = { accountId: 'relayer.sandbox' } as Account
  const pending: TransferAttempt = { tx: 'Hash1', nonce: '50', height: '1000', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), signed: 'AA==' }

  function chain(over: Record<string, (...a: unknown[]) => Promise<unknown>>) {
    const calls: string[] = []
    const base: Record<string, (...a: unknown[]) => Promise<unknown>> = {
      viewNodeStatus: async () => ({ sync_info: { earliest_block_height: 0 } }),
      viewAccessKey: async () => ({ nonce: 80n, block_height: 1_010 }),
      viewBlock: async () => ({ header: { height: 1_010 } }),
      viewTransactionStatus: async () => ({ final_execution_status: 'FINAL', status: { SuccessValue: '' } }),
      sendTransactionUntil: async () => {
        throw new Error('should not rebroadcast')
      },
      ...over,
    }
    const provider = new Proxy({} as Provider, {
      get: (_t, m) => (typeof m === 'string' && m !== 'then' ? (...a: unknown[]) => (calls.push(m), base[m]!(...a)) : undefined),
    })
    return { provider, calls }
  }

  it("reads the endpoint's history, then the key nonce, then the transaction, then the head", async () => {
    const c = chain({})
    expect(await nearTransfers(relayer, c.provider, LIMITS).status(pending)).toBe('succeeded')
    expect(c.calls.indexOf('viewNodeStatus')).toBeLessThan(c.calls.indexOf('viewAccessKey'))
    expect(c.calls.indexOf('viewAccessKey')).toBeLessThan(c.calls.indexOf('viewTransactionStatus'))
    expect(c.calls.indexOf('viewTransactionStatus')).toBeLessThan(c.calls.indexOf('viewBlock'))
  })

  it('an unused nonce read before expiry is not proof, even when the head is past it', async () => {
    const missing = async () => {
      throw new UnknownTransactionError('Hash1')
    }
    const c = chain({ viewAccessKey: async () => ({ nonce: 49n, block_height: 1_100 }), viewTransactionStatus: missing, viewBlock: async () => ({ header: { height: 5_000 } }) })
    expect(await nearTransfers(relayer, c.provider, LIMITS).status(pending)).toBe('unknown')
  })

  it('with one endpoint, a failure resting on a lookup stays unknown: nothing can confirm it', async () => {
    const failed = chain({ viewTransactionStatus: async () => ({ final_execution_status: 'FINAL', status: { Failure: {} } }) })
    expect(await nearTransfers(relayer, failed.provider, LIMITS).status(pending)).toBe('unknown')
    const missing = chain({
      viewTransactionStatus: async () => {
        throw new UnknownTransactionError('Hash1')
      },
    })
    expect(await nearTransfers(relayer, missing.provider, LIMITS).status(pending)).toBe('unknown')
  })

  it('an unused nonce past expiry is failed from one endpoint: it comes from a single response', async () => {
    const c = chain({
      viewAccessKey: async () => ({ nonce: 49n, block_height: 1_111 }),
      viewTransactionStatus: async () => {
        throw new UnknownTransactionError('Hash1')
      },
    })
    expect(await nearTransfers(relayer, c.provider, LIMITS).status(pending)).toBe('failed')
  })

  it('a failed lookup throws', async () => {
    const down = chain({
      viewTransactionStatus: async () => {
        throw new Error('fetch failed')
      },
    })
    await expect(nearTransfers(relayer, down.provider, LIMITS).status(pending)).rejects.toThrow('fetch failed')
  })

  it('a non-final response is unknown, not succeeded', async () => {
    const c = chain({ viewTransactionStatus: async () => ({ final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' } }) })
    expect(await nearTransfers(relayer, c.provider, LIMITS).status(pending)).toBe('unknown')
  })
})

describe('nearTransfers.status across several endpoints', () => {
  const relayer = { accountId: 'relayer.sandbox' } as Account
  const pending: TransferAttempt = { tx: 'Hash1', nonce: '50', height: '1000', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), signed: 'AA==' }
  const down = async () => {
    throw new Error('fetch failed')
  }
  const missing = async () => {
    throw new UnknownTransactionError('Hash1')
  }

  function endpoint(name: string, calls: string[], over: Record<string, (...a: unknown[]) => Promise<unknown>> = {}) {
    const base: Record<string, (...a: unknown[]) => Promise<unknown>> = {
      viewNodeStatus: async () => ({ sync_info: { earliest_block_height: 0 } }),
      viewAccessKey: async () => ({ nonce: 80n, block_height: 1_010 }),
      viewBlock: async () => ({ header: { height: 1_010 } }),
      viewTransactionStatus: async () => ({ final_execution_status: 'FINAL', status: { SuccessValue: '' } }),
      sendTransactionUntil: async () => {
        throw new Error('should not rebroadcast')
      },
      ...over,
    }
    return new Proxy({} as Provider, {
      get: (_t, m) => (typeof m === 'string' && m !== 'then' ? (...a: unknown[]) => (calls.push(`${name}.${m}`), base[m]!(...a)) : undefined),
    })
  }

  it('refuses the same endpoint twice: it would confirm its own reading', () => {
    const calls: string[] = []
    const a = endpoint('a', calls)
    expect(() => nearTransfers(relayer, endpoint('send', calls), LIMITS, [a, endpoint('b', calls), a])).toThrow(/twice/)
  })

  it('takes every reading of a settlement from one endpoint', async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls), endpoint('b', calls)])
    expect(await t.status(pending)).toBe('succeeded')
    expect(calls).toEqual(['a.viewNodeStatus', 'a.viewAccessKey', 'a.viewTransactionStatus', 'a.viewBlock'])
  })

  it("starts over on the next endpoint when one fails partway, never mixing two endpoints' readings", async () => {
    const calls: string[] = []
    // a: the nonce looks used, then a's lookup fails. b: the nonce is unused, and b has no record.
    // Mixed, "used nonce + no record" would read as failed and allow a resend. From b alone, the
    // transfer can still land.
    const a = endpoint('a', calls, { viewTransactionStatus: down })
    const b = endpoint('b', calls, { viewAccessKey: async () => ({ nonce: 49n, block_height: 1_010 }), viewTransactionStatus: missing })
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [a, b])
    expect(await t.status(pending)).toBe('unknown')
    expect(calls.slice(0, 7)).toEqual(['a.viewNodeStatus', 'a.viewAccessKey', 'a.viewTransactionStatus', 'b.viewNodeStatus', 'b.viewAccessKey', 'b.viewTransactionStatus', 'b.viewBlock'])
  })

  it('keeps using the endpoint that last worked', async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewAccessKey: down }), endpoint('b', calls)])
    await t.status(pending)
    calls.length = 0
    await t.status(pending)
    expect(calls[0]).toBe('b.viewNodeStatus')
  })

  it("doesn't ask another endpoint when the chain itself answers", async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewAccessKey: missing }), endpoint('b', calls)])
    await expect(t.status(pending)).rejects.toBeInstanceOf(UnknownTransactionError)
    expect(calls.some((c) => c.startsWith('b.'))).toBe(false)
  })

  it('a failure resting on a lookup counts only when a second endpoint agrees', async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewTransactionStatus: missing }), endpoint('b', calls, { viewTransactionStatus: missing })])
    expect(await t.status(pending)).toBe('failed')
    expect(calls.filter((c) => c.endsWith('viewTransactionStatus'))).toEqual(['a.viewTransactionStatus', 'b.viewTransactionStatus'])
  })

  it('if the second endpoint finds the transfer landed, it landed', async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewTransactionStatus: missing }), endpoint('b', calls)])
    expect(await t.status(pending)).toBe('succeeded')
  })

  it('stays unknown when the second endpoint is down or can only say unknown', async () => {
    const calls: string[] = []
    const lagging = endpoint('b', calls, { viewTransactionStatus: async () => ({ final_execution_status: 'INCLUDED', status: {} }) })
    expect(await nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewTransactionStatus: missing }), lagging]).status(pending)).toBe('unknown')
    const down2 = endpoint('c', calls, { viewNodeStatus: down })
    expect(await nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewTransactionStatus: missing }), down2]).status(pending)).toBe('unknown')
  })

  it('throws, so activation stays blocked, when every endpoint is down', async () => {
    const calls: string[] = []
    const t = nearTransfers(relayer, endpoint('send', calls), LIMITS, [endpoint('a', calls, { viewAccessKey: down }), endpoint('b', calls, { viewBlock: down })])
    await expect(t.status(pending)).rejects.toThrow('fetch failed')
  })
})
