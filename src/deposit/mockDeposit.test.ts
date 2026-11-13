import { describe, expect, it, vi } from 'vitest'
import { GameError } from '../game/types'
import { MockDepositService } from './mockDeposit'
import type { DepositStatus } from './types'

const instant = () => Promise.resolve()
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('MockDepositService', () => {
  it('discovers USDC on Base only', async () => {
    const svc = new MockDepositService(() => {}, instant)
    const assets = await svc.getBalances()
    expect(assets.map((a) => `${a.symbol}@${a.chain}`)).toEqual(['USDC@Base'])
  })

  it('quotes a fee, credits the receive amount with the join msg, and spends the source balance', async () => {
    const credit = vi.fn()
    const svc = new MockDepositService(credit, instant)
    const q = await svc.getQuote({ account: 'you.near', assetId: 'base:usdc', amountUsd: 30, target: 'court' })
    expect(q.receive + Math.round(q.feeUsd * 1e6)).toBe(30_000_000)
    const id = await svc.submitDeposit(q)
    const seen: DepositStatus['phase'][] = []
    svc.trackStatus(id, (s) => seen.push(s.phase))
    await flush()
    expect(seen).toEqual(['settling', 'credited'])
    expect(credit).toHaveBeenCalledWith('you.near', q.receive, { join: true })
    expect((await svc.getBalances())[0]!.usd).toBe(220)
  })

  it('still settles after the watcher unsubscribes', async () => {
    const credit = vi.fn()
    const svc = new MockDepositService(credit, instant)
    const q = await svc.getQuote({ account: 'you.near', assetId: 'base:usdc', amountUsd: 10, target: 'balance' })
    const stop = svc.trackStatus(await svc.submitDeposit(q), () => {})
    stop()
    await flush()
    expect(credit).toHaveBeenCalledWith('you.near', q.receive, undefined)
  })

  it('refuses amounts above the discovered balance', async () => {
    const svc = new MockDepositService(() => {}, instant)
    await expect(svc.getQuote({ account: 'you.near', assetId: 'base:usdc', amountUsd: 251, target: 'court' })).rejects.toThrow('$250.00')
  })

  it('reports a failed follow-up instead of failing silently', async () => {
    const svc = new MockDepositService(() => {
      throw new GameError('INVALID_AMOUNT', 'Join failed.')
    }, instant)
    const q = await svc.getQuote({ account: 'you.near', assetId: 'base:usdc', amountUsd: 5, target: 'court' })
    const seen: DepositStatus[] = []
    svc.trackStatus(await svc.submitDeposit(q), (s) => seen.push(s))
    await flush()
    expect(seen.at(-1)).toEqual({ phase: 'failed', reason: 'Join failed. The USDC is in your game balance.' })
  })
})
