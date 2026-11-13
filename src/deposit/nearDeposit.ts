// Direct deposit from the player's NEAR wallet: test USDC goes to RugPool through
// `ft_transfer_call`. Milestone 1 rehearsal stand-in for Trustware + NEAR Intents.

import { receiptFailure, returnValue, type Near } from '../near/near'
import type { DepositService, DepositStatus, Quote, QuoteRequest, SourceAsset } from './types'

const ASSET_ID = 'near:tusdc'
const QUOTE_TTL_MS = 30_000
/** One wallet confirmation plus a few blocks. */
const ETA_MS = 5_000

type Result = { ok: true; amount: number; target: Quote['request']['target'] } | { ok: false; reason: string }

export class NearDepositService implements DepositService {
  private readonly near: Near
  private quotes = new Map<string, Quote>()
  private results = new Map<string, Result>()
  private seq = 0

  constructor(near: Near) {
    this.near = near
  }

  async getBalances(account: string): Promise<SourceAsset[]> {
    const amount = await this.near.view<string>(this.near.config.usdc, 'ft_balance_of', { account_id: account })
    return [{ id: ASSET_ID, symbol: 'tUSDC', chain: 'NEAR testnet', chainId: 0, amount, decimals: 6, usd: Number(amount) / 1_000_000 }]
  }

  async getQuote(req: QuoteRequest): Promise<Quote> {
    if (req.assetId !== ASSET_ID) throw new Error('That asset is no longer available.')
    if (!(req.amountUsd > 0)) throw new Error('Enter an amount above zero.')
    const [asset] = await this.getBalances(req.account)
    if (asset && req.amountUsd > asset.usd) throw new Error(`You have $${asset.usd.toFixed(2)} of tUSDC on NEAR testnet.`)
    const micro = Math.round(req.amountUsd * 1_000_000)
    const quote: Quote = {
      id: `n${++this.seq}`,
      request: req,
      sendAmount: String(micro),
      sendSymbol: 'tUSDC',
      sendChain: 'NEAR testnet',
      feeUsd: 0,
      receive: micro,
      etaMs: ETA_MS,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    }
    this.quotes.set(quote.id, quote)
    return quote
  }

  /** Resolves once the transaction has executed; `trackStatus` then reports the result. */
  async submitDeposit(quote: Quote): Promise<string> {
    if (!this.quotes.has(quote.id)) throw new Error('Quote not found. Get a new quote.')
    if (Date.now() > quote.expiresAt) throw new Error('Quote expired. Get a new quote.')
    const { target } = quote.request
    const msg = JSON.stringify({ action: target === 'court' ? 'join' : 'balance' })
    const outcome = await this.near.call(this.near.config.usdc, 'ft_transfer_call', { receiver_id: this.near.config.rugpool, amount: quote.sendAmount, msg }, { tgas: 100, deposit: '1' })
    // ft_transfer_call returns the amount RugPool kept; "0" means it refused and the token refunded you.
    const used = Number(returnValue(outcome))
    this.quotes.delete(quote.id)
    this.results.set(
      quote.id,
      used > 0 ? { ok: true, amount: used, target } : { ok: false, reason: `${receiptFailure(outcome)?.message ?? 'RugPool refused the deposit.'} The USDC was returned to your wallet.` },
    )
    return quote.id
  }

  trackStatus(id: string, onUpdate: (s: DepositStatus) => void): () => void {
    const r = this.results.get(id)
    this.results.delete(id)
    onUpdate(!r ? { phase: 'failed', reason: 'Unknown deposit.' } : r.ok ? { phase: 'credited', amount: r.amount, target: r.target } : { phase: 'failed', reason: r.reason })
    return () => {}
  }
}
