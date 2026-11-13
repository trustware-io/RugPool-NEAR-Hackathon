// An RPC provider that fails over between endpoints only when an endpoint fails, never when the
// chain answers. near-api-js's FailoverRpcProvider (7.3.1) catches every error but
// AccountDoesNotExist and throws "Exceeded N providers" instead, which hid `NotEnoughBalance`
// from players and kept `Account` from seeing `InvalidNonce`, so it never refreshed its cached
// nonce (the relayer's stuck nonce in M12).

import { JsonRpcProvider, type Provider } from 'near-api-js'
import {
  DoesNotTrackShardError,
  InternalRpcError,
  NoSyncedBlocksError,
  NodeIsSyncingError,
  NotSyncedYetError,
  RequestRoutedError,
  RpcError,
  TransactionTimeoutError,
  UnavailableShardError,
} from 'near-api-js/rpc-errors'

/** Errors that say something about the endpoint, not the request: another endpoint may succeed. */
const ENDPOINT_ERRORS = [InternalRpcError, NodeIsSyncingError, NoSyncedBlocksError, NotSyncedYetError, UnavailableShardError, DoesNotTrackShardError, RequestRoutedError, TransactionTimeoutError]

/** Whether `e` is the chain's answer to the request, which every endpoint would give. */
export function isChainAnswer(e: unknown): boolean {
  return e instanceof RpcError && !ENDPOINT_ERRORS.some((cls) => e instanceof cls)
}

/**
 * Calls each endpoint in turn, starting with the last one that worked. A chain answer (an
 * invalid nonce, a missing account, a failed transaction) is thrown at once. Resending a signed
 * transaction to the next endpoint is safe: the chain deduplicates it by hash.
 */
export function failoverProvider(providers: Provider[]): Provider {
  if (providers.length === 0) throw new Error('At least one RPC endpoint is needed.')
  let current = 0
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    let last: unknown
    for (let i = 0; i < providers.length; i++) {
      const p = providers[(current + i) % providers.length] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      try {
        const result = await p[method]!(...args)
        current = (current + i) % providers.length
        return result
      } catch (e) {
        if (isChainAnswer(e)) throw e
        last = e
      }
    }
    throw last
  }
  // Provider has some forty methods; every one is forwarded the same way. `then` stays undefined
  // so awaiting the provider itself doesn't mistake it for a promise.
  return new Proxy({} as Provider, {
    get: (_t, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => call(method, args) : undefined),
  })
}

/**
 * A comma-separated RPC endpoint list, trimmed. A URL listed twice is refused, however it is
 * written: activation counts a second endpoint's agreement as confirmation, and an endpoint must
 * not confirm itself. Two different URLs can still reach the same operator; that isn't checked.
 */
export function parseRpcUrls(list: string): string[] {
  const seen = new Set<string>()
  return list.split(',').map((entry) => {
    const url = entry.trim()
    let key: string
    try {
      key = new URL(url).href
    } catch {
      throw new Error(`Not an RPC URL: "${url}"`)
    }
    if (seen.has(key)) throw new Error(`RPC endpoint listed twice: ${url}`)
    seen.add(key)
    return url
  })
}

export function rpcProvider(urls: string[]): Provider {
  return failoverProvider(urls.map((url) => new JsonRpcProvider({ url })))
}
