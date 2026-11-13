// NEAR transfers whose outcome can be settled from the chain, so a payer never resends one that
// might still land. A transfer is signed first, and its identity (hash, nonce, reference block)
// is recorded before it is sent. A send that throws proves nothing: the transaction may have
// reached the chain anyway (failover even rebroadcasts it to a second endpoint). So its fate is
// read back from the chain, and it counts as failed only when the chain proves it never landed
// and never will. A landed transaction sets its key's nonce to its own, so:
//
// - If the key's nonce is still below the transfer's, it hasn't landed. It fails once its
//   reference block is past the transaction validity period; until then it can still land, so
//   the same signed bytes are rebroadcast (a transaction lands at most once).
// - If the key's nonce has reached it, either it landed or another transaction used the nonce.
//   Only the lookup tells which, and RPC nodes drop old blocks (and their transactions) after a
//   few epochs, as few as 2 on a free public endpoint. So "no record" counts as failed only when
//   the transfer is well inside the history that endpoint reports it still holds, and within a
//   fixed window as a backstop.
//
// "Not landed, and now expired" is read from one chain state: the key's nonce together with the
// height of the block it was read at, so a transfer landing a moment later can't be mistaken for
// a dead one. The key is read before the transaction is looked up, and the head after, so the
// lookup is never older than the nonce and the history window is judged conservatively.
//
// Settlement reads from one RPC endpoint at a time, falling back to the next if one fails
// partway (its readings are then discarded). An endpoint is a URL, not a node: free public
// endpoints are load-balanced, so one request can reach a node that is behind, or has dropped
// more history, than the node that answered the one before. Two kinds of verdict follow:
//
// - "Nonce unused at a height past expiry" comes from a single response (the access key with the
//   height it was read at), so load-balancing can't split it. One endpoint is enough.
// - Any "failed" that rests on a lookup (a reported failure, or no record with a used nonce)
//   could come from one bad node. It counts only if a second, different endpoint independently
//   reaches "failed" too; if it finds the transfer landed, that wins; otherwise it stays unknown.

import { actions, baseEncode, encodeTransaction, SignedTransaction, type Account, type Provider } from 'near-api-js'
import { TransactionTimeoutError, UnknownTransactionError } from 'near-api-js/rpc-errors'
import { isChainAnswer } from './rpc'

/** A signed transfer's identity, recorded before it is sent. */
export interface TransferAttempt {
  /** Transaction hash (base58). */
  tx: string
  nonce: string
  /** Height of the block the transaction references: it can't land after this + the validity period. */
  height: string
  /** The signing key, whose nonce shows whether this nonce was used. */
  publicKey: string
  /** The signed transaction (base64), to rebroadcast while it can still land. */
  signed: string
}

/** 'unknown': the transfer may still land, or may have landed; never send another meanwhile. */
export type TransferOutcome = 'succeeded' | 'failed' | 'unknown'

export interface Transfers {
  /** Signs a transfer without sending it, so its identity can be recorded first. */
  prepare(accountId: string, amount: bigint): Promise<{ attempt: TransferAttempt; send: () => Promise<'succeeded' | 'failed'> }>
  /** What became of an attempt, as far as the chain can prove. Throws if the chain can't be asked. */
  status(attempt: TransferAttempt): Promise<TransferOutcome>
}

/** What the chain says about a transaction hash: a final outcome, still in progress, or no record. */
export type Lookup = 'succeeded' | 'failed' | 'pending' | 'missing'

export interface ChainLimits {
  /** Blocks after its reference block that a transaction stays valid (genesis `transaction_validity_period`). */
  validityBlocks: bigint
  /** Blocks after its reference block that the RPC can still be trusted to know a transaction. */
  historyBlocks: bigint
  /** How far inside an endpoint's reported history a transfer must be for "no record" to count. */
  retentionMarginBlocks: bigint
}

/** Slack on the validity period, so an off-by-one in when nearcore counts it can't matter. */
const EXPIRY_MARGIN = 10n

/** What one endpoint reported, in the order it was read. */
export interface ChainReading {
  /** The earliest block the endpoint still holds, or null if it didn't say. */
  earliest: bigint | null
  keyNonce: bigint
  /** The height the key was read at. */
  keyHeight: bigint
  lookup: Lookup
  head: bigint
}

export interface Verdict {
  outcome: TransferOutcome
  /** The transaction can still land, so rebroadcasting it is worthwhile. */
  landable: boolean
  /** A "failed" that rests on a lookup, so a second endpoint must agree before it counts. */
  confirm: boolean
}

/** Settles an attempt from one endpoint's readings. */
export function classifyAttempt(attempt: { nonce: bigint; height: bigint }, chain: ChainReading, limits: ChainLimits): Verdict {
  if (chain.lookup === 'succeeded') return { outcome: 'succeeded', landable: false, confirm: false }
  if (chain.lookup === 'failed') return { outcome: 'failed', landable: false, confirm: true }
  if (chain.lookup === 'pending') return { outcome: 'unknown', landable: false, confirm: false }
  if (chain.keyNonce < attempt.nonce) {
    const expired = chain.keyHeight > attempt.height + limits.validityBlocks + EXPIRY_MARGIN
    return expired ? { outcome: 'failed', landable: false, confirm: false } : { outcome: 'unknown', landable: true, confirm: false }
  }
  const remembered = chain.earliest !== null && attempt.height >= chain.earliest + limits.retentionMarginBlocks && chain.head - attempt.height <= limits.historyBlocks
  return remembered ? { outcome: 'failed', landable: false, confirm: true } : { outcome: 'unknown', landable: false, confirm: false }
}

/** A final outcome from a transaction response, or 'pending' if it isn't final yet. */
function finalOutcome(res: unknown): 'succeeded' | 'failed' | 'pending' {
  if (typeof res !== 'object' || res === null) return 'pending'
  const r = res as { final_execution_status?: unknown; status?: unknown }
  if (r.final_execution_status !== 'FINAL' || typeof r.status !== 'object' || r.status === null) return 'pending'
  if ('Failure' in r.status) return 'failed'
  if ('SuccessValue' in r.status) return 'succeeded'
  return 'pending'
}

/** The transaction hash: sha256 of the borsh-encoded transaction, base58. */
export async function transactionHash(signed: SignedTransaction): Promise<string> {
  return baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(signed.transaction)))))
}

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * `provider` signs and sends (failover between endpoints is safe there: the chain deduplicates a
 * transaction by hash). `endpoints` are the individual RPC endpoints a settlement reads from, one
 * at a time, starting with the last one that worked. Each must be a different endpoint (the relayer
 * refuses a URL listed twice): a second reading confirms a first only if it comes from elsewhere.
 */
export function nearTransfers(account: Account, provider: Provider, limits: ChainLimits, endpoints: Provider[] = [provider]): Transfers {
  if (endpoints.length === 0) throw new Error('At least one RPC endpoint is needed.')
  if (new Set(endpoints).size !== endpoints.length) throw new Error('An RPC endpoint is listed twice: it would confirm its own reading.')
  let current = 0

  async function submit(signed: SignedTransaction): Promise<'succeeded' | 'failed'> {
    const outcome = finalOutcome(await provider.sendTransactionUntil(signed, 'FINAL'))
    if (outcome === 'pending') throw new Error('The transfer is not final yet.')
    return outcome
  }

  // Asked without waiting: a known transaction comes back with its current status at once, and
  // an unknown hash is reported unknown. Asked to wait, the RPC holds an unknown hash until it
  // times out (seen on the local chain), which says nothing.
  async function lookup(rpc: Provider, tx: string): Promise<Lookup> {
    try {
      return finalOutcome(await rpc.viewTransactionStatus({ txHash: tx, accountId: account.accountId, waitUntil: 'NONE' }))
    } catch (e) {
      if (e instanceof UnknownTransactionError) return 'missing'
      if (e instanceof TransactionTimeoutError) return 'pending'
      throw e
    }
  }

  /**
   * The endpoint's history, the key, the lookup and the head, all from one endpoint: the first
   * that answers, starting with the last one that worked and skipping `skip`.
   */
  async function readChain(attempt: TransferAttempt, skip?: number): Promise<{ reading: ChainReading; at: number }> {
    let last: unknown = new Error('No other RPC endpoint to confirm with.')
    for (let i = 0; i < endpoints.length; i++) {
      const at = (current + i) % endpoints.length
      if (at === skip) continue
      const rpc = endpoints[at]!
      try {
        // First, so the history it reports can only have shrunk by the time of the lookup; the
        // margin covers that.
        const earliest = (await rpc.viewNodeStatus()).sync_info.earliest_block_height
        const key = await rpc.viewAccessKey({ accountId: account.accountId, publicKey: attempt.publicKey, finalityQuery: { finality: 'final' } })
        const found = await lookup(rpc, attempt.tx)
        const head = await rpc.viewBlock({ finality: 'final' })
        if (skip === undefined) current = at
        return { at, reading: { earliest: typeof earliest === 'number' ? BigInt(earliest) : null, keyNonce: BigInt(key.nonce), keyHeight: BigInt(key.block_height), lookup: found, head: BigInt(head.header.height) } }
      } catch (e) {
        if (isChainAnswer(e)) throw e
        last = e
      }
    }
    throw last
  }

  return {
    async prepare(receiverId, amount) {
      const signed = await account.createSignedTransaction({ receiverId, actions: [actions.transfer(amount)] })
      const block = await provider.viewBlock({ blockId: baseEncode(signed.transaction.blockHash) })
      const attempt: TransferAttempt = {
        tx: await transactionHash(signed),
        nonce: signed.transaction.nonce.toString(),
        height: String(block.header.height),
        publicKey: signed.transaction.publicKey.toString(),
        signed: toBase64(signed.encode()),
      }
      return { attempt, send: () => submit(signed) }
    },

    async status(attempt) {
      const settle = (reading: ChainReading) => classifyAttempt({ nonce: BigInt(attempt.nonce), height: BigInt(attempt.height) }, reading, limits)
      const first = await readChain(attempt)
      const { outcome, landable, confirm } = settle(first.reading)
      if (confirm) {
        let second: Verdict
        try {
          second = settle((await readChain(attempt, first.at)).reading)
        } catch {
          return 'unknown'
        }
        return second.outcome === 'succeeded' || second.outcome === 'failed' ? second.outcome : 'unknown'
      }
      if (outcome !== 'unknown' || !landable) return outcome
      // Lost before it reached the chain (a crash before sending, say): send the same signed bytes.
      // A transaction lands at most once, so this can't pay twice.
      try {
        return await submit(SignedTransaction.decode(fromBase64(attempt.signed)))
      } catch {
        return 'unknown'
      }
    },
  }
}
