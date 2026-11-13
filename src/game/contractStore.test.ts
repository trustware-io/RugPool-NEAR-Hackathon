import { describe, expect, it } from 'vitest'
import type { Near } from '../near/near'
import { ContractStore } from './contractStore'
import { GameError } from './types'

const panic = (text: string) => ({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } } } })

/** Just enough of `Near` for the store: one signed-in account, canned outcomes and views. */
function fakeNear(outcome: unknown, nextPrice = '5304500', rpcDown = false): { near: Near; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = []
  const near = {
    config: { rugpool: 'pool.testnet', usdc: 'usdc.testnet', rpcUrls: [] },
    connector: { on: () => {} },
    restoredAccount: async () => null,
    connect: async () => 'alice.testnet',
    chainNowMs: async () => {
      if (rpcDown) throw new Error('RetriesExceeded')
      return Date.now()
    },
    view: async () => {
      if (rpcDown) throw new Error('RetriesExceeded')
      return { round: { next_price: nextPrice } }
    },
    call: async (_to: string, method: string, args: unknown) => {
      calls.push({ method, args })
      return outcome
    },
    // No session key: every action goes to the wallet.
    relayCall: async () => null,
  }
  return { near: near as unknown as Near, calls }
}

describe('ContractStore.challenge', () => {
  it('arms auto-defend on the contract', async () => {
    const { near, calls } = fakeNear({ status: { SuccessValue: '' } })
    const store = new ContractStore(near)
    await store.connect()
    await store.setAutoDefend('7000000')
    expect(calls).toEqual([{ method: 'set_auto_defend', args: { max_price: '7000000' } }])
  })

  it('sends the max price to the contract', async () => {
    const { near, calls } = fakeNear({ status: { SuccessValue: '' } })
    const store = new ContractStore(near)
    await store.connect()
    await store.challenge('5150000')
    expect(calls).toEqual([{ method: 'challenge', args: { max_price: '5150000' } }])
  })

  it('attaches the live price when the price moved', async () => {
    const { near } = fakeNear(panic('PRICE_MOVED: The price moved above your max.'))
    const store = new ContractStore(near)
    await store.connect()
    const err = await store.challenge('5150000').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GameError)
    expect((err as GameError).code).toBe('PRICE_MOVED')
    expect((err as GameError).price).toBe('5304500')
  })

  it('still reports PRICE_MOVED when the price cannot be re-read', async () => {
    const { near } = fakeNear(panic('PRICE_MOVED: The price moved above your max.'), '5304500', true)
    const store = new ContractStore(near)
    await store.connect()
    const err = await store.challenge('5150000').catch((e: unknown) => e)
    expect((err as GameError).code).toBe('PRICE_MOVED')
    expect((err as GameError).price).toBeUndefined()
  })

  it('maps other refusals to their codes', async () => {
    const { near } = fakeNear(panic('COURT_TOO_SMALL: You need $25 in the Court to challenge.'))
    const store = new ContractStore(near)
    await store.connect()
    const err = await store.challenge('5150000').catch((e: unknown) => e)
    expect((err as GameError).code).toBe('COURT_TOO_SMALL')
  })

  it('refuses before signing when nobody is connected', async () => {
    const { near, calls } = fakeNear({ status: { SuccessValue: '' } })
    const err = await new ContractStore(near).challenge('5150000').catch((e: unknown) => e)
    expect((err as GameError).code).toBe('NOT_CONNECTED')
    expect(calls).toEqual([])
  })
})

describe('ContractStore.getState', () => {
  it('keeps polling when the clock sync fails', async () => {
    const { near } = fakeNear({ status: { SuccessValue: '' } })
    ;(near as unknown as { chainNowMs: () => Promise<number> }).chainNowMs = async () => {
      throw new Error('429 Too Many Requests')
    }
    const state = await new ContractStore(near).getState()
    expect(state.round.next_price).toBe('5304500')
  })
})

describe('ContractStore with a session key', () => {
  it('relays game actions instead of asking the wallet', async () => {
    const { near, calls } = fakeNear({ status: { SuccessValue: '' } })
    const relayed: Array<{ method: string; args: unknown }> = []
    ;(near as unknown as { relayCall: (to: string, method: string, args: unknown) => Promise<unknown> }).relayCall = async (_to, method, args) => {
      relayed.push({ method, args })
      return { status: { SuccessValue: btoa('true') } }
    }
    const store = new ContractStore(near)
    await store.connect()
    await store.challenge('5150000')
    await store.claim()
    expect(relayed).toEqual([
      { method: 'challenge', args: { max_price: '5150000' } },
      { method: 'claim', args: {} },
    ])
    expect(calls).toEqual([])
  })

  it('maps a relayed refusal to its code', async () => {
    const { near } = fakeNear({ status: { SuccessValue: '' } })
    ;(near as unknown as { relayCall: () => Promise<unknown> }).relayCall = async () => panic('PAUSED: The game is paused. Claims and withdrawals still work.')
    const store = new ContractStore(near)
    await store.connect()
    const err = await store.setAutoDefend('7000000').catch((e: unknown) => e)
    expect((err as GameError).code).toBe('PAUSED')
  })
})

describe('ContractStore.getEvents', () => {
  it('drops events the app does not know, keeping the cursor', async () => {
    const { near } = fakeNear({ status: { SuccessValue: '' } })
    ;(near as unknown as { view: () => Promise<unknown> }).view = async () => ({
      events: [
        { id: 25, at: 1, type: 'deposit_held', data: { amount: '2000000' } },
        { id: 26, at: 2, type: 'draw_won', data: { by: 'bob.testnet', amount: '5950662' } },
        { id: 27, at: 3, type: 'something_new', data: {} },
      ],
      cursor: 27,
    })
    const page = await new ContractStore(near).getEvents(24)
    expect(page.events.map((e) => e.type)).toEqual(['draw_won'])
    expect(page.cursor).toBe(27)
  })
})
