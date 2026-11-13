import { describe, expect, it } from 'vitest'
import { GameError } from '../game/types'
import { gameOutcome, nearConfigFromEnv, receiptFailure, returnValue, toActionError } from './near'

const panic = (text: string) => ({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } })
const ok = (json: unknown) => ({ SuccessValue: btoa(JSON.stringify(json)) })

describe('toActionError', () => {
  it('maps a contract panic with a known code to a GameError', () => {
    const e = toActionError(panic('COOLDOWN: The withdrawal cooldown has not ended.'))
    expect(e).toBeInstanceOf(GameError)
    expect((e as GameError).code).toBe('COOLDOWN')
    expect(e.message).toBe('The withdrawal cooldown has not ended.')
  })

  it('keeps the message of codes the app does not know', () => {
    const e = toActionError(panic('INVALID_MSG: Unrecognized deposit message.'))
    expect(e).not.toBeInstanceOf(GameError)
    expect(e.message).toBe('Unrecognized deposit message.')
  })

  it('passes wallet errors through', () => {
    expect(toActionError(new Error('User rejected the request')).message).toBe('User rejected the request')
  })
})

describe('returnValue', () => {
  it('decodes the JSON return value', () => {
    expect(returnValue({ status: ok(true), receipts_outcome: [] })).toBe(true)
  })

  it('throws the panic when the transaction failed', () => {
    expect(() => returnValue({ status: { Failure: panic('NOTHING_TO_CLAIM: Nothing to claim yet.') } })).toThrow('Nothing to claim yet.')
  })

  it('rejects a missing outcome', () => {
    expect(() => returnValue(undefined)).toThrow('no transaction outcome')
  })
})

describe('receiptFailure', () => {
  it('finds a refused ft_on_transfer behind a successful ft_transfer_call', () => {
    const outcome = {
      status: ok('0'),
      receipts_outcome: [{ outcome: { status: ok(null) } }, { outcome: { status: { Failure: panic('INVALID_AMOUNT: Deposit at least 1 USDC.') } } }],
    }
    expect(returnValue(outcome)).toBe('0')
    expect(receiptFailure(outcome)?.message).toBe('Deposit at least 1 USDC.')
  })
})

describe('gameOutcome', () => {
  // Shaped like testnet tx 6cTicBtexhinjEX6iTmhFZVBai6R4ZdACnS45sZVHbtN: the relayer's Delegate
  // succeeded, and the challenge inside it was refused.
  const relayed = (poolStatus: unknown, more: Array<{ id: string; outcome: { executor_id: string; status: unknown } }> = []) => ({
    status: ok(null),
    transaction: { hash: 'tx' },
    receipts_outcome: [
      { id: 'r1', outcome: { executor_id: 'player.testnet', status: { SuccessValue: '' } } },
      { id: 'r2', outcome: { executor_id: 'pool2.testnet', status: poolStatus } },
      { id: 'r3', outcome: { executor_id: 'relayer.testnet', status: { SuccessValue: '' } } },
      ...more,
    ],
  })

  it('reports the refusal inside a relayed Delegate, not the outer success', () => {
    const outcome = relayed({ Failure: panic('ROUND_CLOSED: The showdown is over. The King is being crowned.') })
    expect(returnValue(outcome)).toBeNull()
    const e = (() => {
      try {
        returnValue(gameOutcome(outcome, 'pool2.testnet'))
      } catch (err) {
        return err
      }
    })()
    expect(e).toBeInstanceOf(GameError)
    expect((e as GameError).code).toBe('ROUND_CLOSED')
  })

  it('follows a promise to the callback that returns the value (claim, withdraw)', () => {
    const outcome = relayed({ SuccessReceiptId: 'r5' }, [
      { id: 'r4', outcome: { executor_id: 'tusdc.testnet', status: { SuccessValue: '' } } },
      { id: 'r5', outcome: { executor_id: 'pool2.testnet', status: ok(true) } },
    ])
    expect(returnValue(gameOutcome(outcome, 'pool2.testnet'))).toBe(true)
  })

  it('keeps the transaction for logging', () => {
    expect((gameOutcome(relayed(ok(null)), 'pool2.testnet') as { transaction: unknown }).transaction).toEqual({ hash: 'tx' })
  })
})

describe('nearConfigFromEnv', () => {
  it('requires both contract ids', () => {
    expect(() => nearConfigFromEnv({ VITE_RUGPOOL_CONTRACT: 'pool.testnet' })).toThrow('VITE_USDC_CONTRACT')
  })

  it('defaults to two RPCs for failover', () => {
    expect(nearConfigFromEnv({ VITE_RUGPOOL_CONTRACT: 'pool.testnet', VITE_USDC_CONTRACT: 'usdc.testnet' }).rpcUrls).toEqual(['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'])
  })

  it('reads a comma-separated RPC list', () => {
    const env = { VITE_RUGPOOL_CONTRACT: 'pool.testnet', VITE_USDC_CONTRACT: 'usdc.testnet', VITE_NEAR_RPC: 'https://a.example, https://b.example' }
    expect(nearConfigFromEnv(env).rpcUrls).toEqual(['https://a.example', 'https://b.example'])
  })
})
