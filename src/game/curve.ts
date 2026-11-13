// Bonding curve and ticket split in integer micro-USDC, the way the contract will compute them.

/** Price of challenge number `k` (0-based) in a round: start, then +step each time, floored. */
export function priceAt(k: number, startPrice: number, stepBps: number): number {
  let p = startPrice
  for (let i = 0; i < k; i++) p = Math.floor((p * (10_000 + stepBps)) / 10_000)
  return p
}

/** Every price paid so far this round, oldest first. */
export function pricesThisRound(challenges: number, startPrice: number, stepBps: number): number[] {
  const out: number[] = []
  let p = startPrice
  for (let i = 0; i < challenges; i++) {
    out.push(p)
    p = Math.floor((p * (10_000 + stepBps)) / 10_000)
  }
  return out
}

/**
 * Splits a ticket into [Jackpot, King, Court, protocol]. Each share is floored and the
 * rounding remainder goes to the Jackpot, so the parts always sum to the price.
 */
export function splitTicket(price: number, splitBps: readonly [number, number, number, number]): [number, number, number, number] {
  const king = Math.floor((price * splitBps[1]) / 10_000)
  const court = Math.floor((price * splitBps[2]) / 10_000)
  const protocol = Math.floor((price * splitBps[3]) / 10_000)
  return [price - king - court - protocol, king, court, protocol]
}
