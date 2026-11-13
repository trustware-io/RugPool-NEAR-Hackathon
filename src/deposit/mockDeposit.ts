import { GameError } from '../game/types'
import type { DepositService, DepositStatus, Quote, QuoteRequest, SourceAsset } from './types'

/** What lands the USDC on the contract: `MockStore.ftOnTransfer` in the mock. */
export type Credit = (account: string, amount: number, msg?: { join: true }) => void

const SIGN_MS = 1_000
const SETTLE_MS = 4_000
const FEE_BPS = 30
const QUOTE_TTL_MS = 30_000

/** Fake Trustware discovery + NEAR Intents settlement: about 5s from signature to credit. */
export class MockDepositService implements DepositService {
  private readonly credit: Credit
  private readonly wait: (ms: number) => Promise<void>
  private readonly assets: SourceAsset[] = [
    { id: 'base:usdc', symbol: 'USDC', chain: 'Base', chainId: 8453, amount: '250000000', decimals: 6, usd: 250 },
  ]
  private quotes = new Map<string, Quote>()
  private seq = 0

  constructor(credit: Credit, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.credit = credit
    this.wait = wait
  }

  async getBalances(): Promise<SourceAsset[]> {
    await this.wait(400)
    return this.assets.map((a) => ({ ...a }))
  }

  async getQuote(req: QuoteRequest): Promise<Quote> {
    await this.wait(500)
    const asset = this.assets.find((a) => a.id === req.assetId)
    if (!asset) throw new Error('That asset is no longer available.')
    if (!(req.amountUsd > 0)) throw new Error('Enter an amount above zero.')
    if (req.amountUsd > asset.usd) throw new Error(`You have $${asset.usd.toFixed(2)} of ${asset.symbol} on ${asset.chain}.`)
    const sendMicro = Math.round(req.amountUsd * 1_000_000)
    const fee = Math.ceil((sendMicro * FEE_BPS) / 10_000)
    const quote: Quote = {
      id: `q${++this.seq}`,
      request: req,
      sendAmount: String(sendMicro),
      sendSymbol: asset.symbol,
      sendChain: asset.chain,
      feeUsd: fee / 1_000_000,
      receive: sendMicro - fee,
      etaMs: SIGN_MS + SETTLE_MS,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    }
    this.quotes.set(quote.id, quote)
    return quote
  }

  async submitDeposit(quote: Quote): Promise<string> {
    if (!this.quotes.has(quote.id)) throw new Error('Quote not found. Get a new quote.')
    if (Date.now() > quote.expiresAt) throw new Error('Quote expired. Get a new quote.')
    await this.wait(SIGN_MS)
    return quote.id
  }

  trackStatus(id: string, onUpdate: (s: DepositStatus) => void): () => void {
    let live = true
    const emit = (s: DepositStatus) => live && onUpdate(s)
    const quote = this.quotes.get(id)
    if (!quote) {
      emit({ phase: 'failed', reason: 'Unknown deposit.' })
      return () => {}
    }
    emit({ phase: 'settling', startedAt: Date.now(), etaMs: SETTLE_MS })
    // Settlement happens whether or not anyone is still watching.
    void this.wait(SETTLE_MS).then(() => {
      const asset = this.assets.find((a) => a.id === quote.request.assetId)
      if (asset) {
        asset.usd = Math.max(0, asset.usd - quote.request.amountUsd)
        asset.amount = String(Math.round(asset.usd * 10 ** asset.decimals))
      }
      const { account, target } = quote.request
      // Like ft_on_transfer: the balance is credited even if the msg follow-up fails.
      try {
        this.credit(account, quote.receive, target === 'court' ? { join: true } : undefined)
      } catch (e) {
        if (!(e instanceof GameError)) throw e
        emit({ phase: 'failed', reason: `${e.message} The USDC is in your game balance.` })
        return
      }
      this.quotes.delete(id)
      emit({ phase: 'credited', amount: quote.receive, target })
    })
    return () => {
      live = false
    }
  }
}
