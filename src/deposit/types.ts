// Cross-chain deposit: Trustware finds the player's balances, NEAR Intents quotes and
// settles USDC to the RugPool contract. The mock and the real service share this interface.

export interface SourceAsset {
  id: string
  symbol: string
  chain: string
  chainId: number
  /** Smallest units, as a string. */
  amount: string
  decimals: number
  usd: number
}

export type DepositTarget = 'court' | 'balance'

export interface QuoteRequest {
  account: string
  assetId: string
  /** USD value to send. */
  amountUsd: number
  target: DepositTarget
}

export interface Quote {
  id: string
  request: QuoteRequest
  sendAmount: string
  sendSymbol: string
  sendChain: string
  feeUsd: number
  /** USDC credited on NEAR, micro-USDC. */
  receive: number
  etaMs: number
  expiresAt: number
}

export type DepositStatus =
  | { phase: 'awaiting_signature' }
  | { phase: 'settling'; startedAt: number; etaMs: number }
  | { phase: 'credited'; amount: number; target: DepositTarget }
  | { phase: 'failed'; reason: string }

export interface DepositService {
  getBalances(account: string): Promise<SourceAsset[]>
  getQuote(req: QuoteRequest): Promise<Quote>
  /** Asks the source wallet to sign; resolves with a deposit id once signed. */
  submitDeposit(quote: Quote): Promise<string>
  /** Calls back on every phase change until credited or failed. Returns an unsubscribe. */
  trackStatus(id: string, onUpdate: (s: DepositStatus) => void): () => void
}
