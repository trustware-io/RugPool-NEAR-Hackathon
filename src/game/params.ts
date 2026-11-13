// Spec values and the demo-time values from RugPool_Build_Plan.md. Money is micro-USDC.

export interface EngineParams {
  startPrice: number
  stepBps: number
  splitBps: [number, number, number, number]
  minCourt: number
  /** Court needed to hold a draw slot; smaller Court deposits get no draw odds. */
  drawMinCourt: number
  /** Showdown trigger as a share of the Court (bps), unless `triggerFixed` is set. */
  triggerBps: number
  triggerFixed: number | null
  backstopMs: number
  showdownMs: number
  snipeMs: number
  maxRetakes: number
  withdrawCooldownMs: number
  drawEveryMs: number
  yieldApyBps: number
  /** Yield split: Court, Jackpot seed, King stream. */
  yieldSplitBps: [number, number, number]
}

const HOUR = 3_600_000

export const SPEC_PARAMS: EngineParams = {
  startPrice: 5_000_000,
  stepBps: 300,
  splitBps: [5500, 2500, 1500, 500],
  minCourt: 25_000_000,
  drawMinCourt: 5_000_000,
  triggerBps: 20,
  triggerFixed: null,
  backstopMs: 6 * HOUR,
  showdownMs: 10 * 60_000,
  snipeMs: 60_000,
  maxRetakes: 25,
  withdrawCooldownMs: 24 * HOUR,
  drawEveryMs: 7 * 24 * HOUR,
  yieldApyBps: 500,
  yieldSplitBps: [5000, 3000, 2000],
}

export const DEMO_PARAMS: EngineParams = {
  ...SPEC_PARAMS,
  triggerFixed: 20_000_000,
  backstopMs: 5 * 60_000,
  showdownMs: 90_000,
  snipeMs: 15_000,
  withdrawCooldownMs: 60_000,
  drawEveryMs: 5 * 60_000,
}

export function isFastMode(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('fast') === '1'
}
