import { describe, expect, it } from 'vitest'
import { checkDelegate, GAME_METHODS, SESSION_KEY_ALLOWANCE, type DelegateLike, type RelayPolicy } from './relayPolicy'

const policy: RelayPolicy = {
  pool: 'pool.testnet',
  token: 'usdc.testnet',
  methods: GAME_METHODS,
  maxGas: 100_000_000_000_000n,
  maxTtlBlocks: 120n,
  sessionMaxAgeBlocks: 1_000n,
  maxKeyDeletes: 4,
}
const TGAS = 1_000_000_000_000n
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
const key = (s: string) => ({ toString: () => s })
type Action = DelegateLike['actions'][number]

function delegate(over: Partial<DelegateLike> = {}): DelegateLike {
  return {
    senderId: 'bob.testnet',
    receiverId: 'pool.testnet',
    maxBlockHeight: 1_100n,
    publicKey: key('ed25519:SIGNER'),
    actions: [{ functionCall: { methodName: 'challenge', args: json({ max_price: '5' }), gas: 30n * TGAS, deposit: 0n } }],
    ...over,
  }
}

const deposit = (args: unknown, over: Partial<{ methodName: string; deposit: bigint }> = {}): DelegateLike =>
  delegate({ receiverId: 'usdc.testnet', actions: [{ functionCall: { methodName: 'ft_transfer_call', args: json(args), gas: 100n * TGAS, deposit: 1n, ...over } }] })
const transfer = (msg?: unknown) => ({ receiver_id: 'pool.testnet', amount: '5000000', ...(msg === undefined ? {} : { msg: typeof msg === 'string' ? msg : JSON.stringify(msg) }) })

const addKey = (over: Partial<{ receiverId: string; methodNames: string[]; allowance: bigint | undefined; full: boolean }> = {}, pk = 'ed25519:NEW'): Action => ({
  addKey: {
    publicKey: key(pk),
    accessKey: {
      permission: over.full
        ? { fullAccess: {} }
        : { functionCall: { receiverId: over.receiverId ?? 'pool.testnet', methodNames: over.methodNames ?? [...GAME_METHODS], allowance: 'allowance' in over ? over.allowance : SESSION_KEY_ALLOWANCE } },
    },
  },
})
const deleteKey = (pk: string): Action => ({ deleteKey: { publicKey: key(pk) } })
const keys = (...actions: Action[]) => delegate({ receiverId: 'bob.testnet', actions })

describe('checkDelegate: game calls', () => {
  it('relays a zero-deposit game call', () => {
    expect(checkDelegate(delegate(), policy, 1_000n)).toEqual({ kind: 'game' })
  })

  it('refuses another receiver, a deposit, or a method outside the game list', () => {
    expect(checkDelegate(delegate({ receiverId: 'other.testnet' }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/receiver/) })
    expect(checkDelegate(delegate({ actions: [{ functionCall: { methodName: 'claim', args: json({}), gas: TGAS, deposit: 1n } }] }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/deposit/) })
    expect(checkDelegate(delegate({ actions: [{ functionCall: { methodName: 'migrate', args: json({}), gas: TGAS, deposit: 0n } }] }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/method/) })
  })

  it('refuses non-call actions and batches', () => {
    expect(checkDelegate(delegate({ actions: [{}] }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/function calls/) })
    expect(checkDelegate(delegate({ actions: [] }), policy, 1_000n)).toEqual({ error: 'no actions' })
    const call = { functionCall: { methodName: 'claim', args: json({}), gas: TGAS, deposit: 0n } }
    expect(checkDelegate(delegate({ actions: [call, call] }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/one action/) })
  })

  it('caps gas and expiry', () => {
    expect(checkDelegate(delegate({ actions: [{ functionCall: { methodName: 'claim', args: json({}), gas: 100n * TGAS + 1n, deposit: 0n } }] }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/gas/) })
    expect(checkDelegate(delegate({ maxBlockHeight: 1_121n }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/too far/) })
    expect(checkDelegate(delegate({ maxBlockHeight: 1_000n }), policy, 1_000n)).toEqual({ error: 'expired' })
  })
})

describe('checkDelegate: deposits', () => {
  it('relays a USDC transfer to the pool for the balance or the Court', () => {
    expect(checkDelegate(deposit(transfer()), policy, 1_000n)).toEqual({ kind: 'deposit' })
    expect(checkDelegate(deposit(transfer({ action: 'balance' })), policy, 1_000n)).toEqual({ kind: 'deposit' })
    expect(checkDelegate(deposit(transfer({ action: 'join', beneficiary: 'bob.testnet' })), policy, 1_000n)).toEqual({ kind: 'deposit' })
  })

  it('refuses a transfer anywhere but the pool, or other token methods', () => {
    expect(checkDelegate(deposit({ ...transfer(), receiver_id: 'mallory.testnet' }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/pool/) })
    expect(checkDelegate(deposit({ receiver_id: 'mallory.testnet', amount: '5' }, { methodName: 'ft_transfer' }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/method/) })
  })

  it('refuses crediting someone else, other actions, and malformed messages', () => {
    expect(checkDelegate(deposit(transfer({ action: 'balance', beneficiary: 'mallory.testnet' })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/sender only/) })
    expect(checkDelegate(deposit(transfer({ action: 'fund_yield' })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/balance or join/) })
    expect(checkDelegate(deposit(transfer('not json')), policy, 1_000n)).toEqual({ error: expect.stringMatching(/message/) })
    expect(checkDelegate(deposit(transfer({ action: 'join', extra: 1 })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/message/) })
  })

  it('refuses odd amounts, extra arguments and the wrong attached deposit', () => {
    for (const amount of ['0', '-5', '1.5', '05', 5]) expect(checkDelegate(deposit({ ...transfer(), amount }), policy, 1_000n)).toEqual({ error: 'invalid deposit amount' })
    expect(checkDelegate(deposit({ ...transfer(), extra: true }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/arguments/) })
    expect(checkDelegate(deposit(transfer(), { deposit: 2n }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/1 yoctoNEAR/) })
  })
})

describe('checkDelegate: key changes', () => {
  it('relays adding a session key, deleting old ones, or both', () => {
    expect(checkDelegate(keys(addKey()), policy, 1_000n)).toEqual({ kind: 'keys' })
    expect(checkDelegate(keys(deleteKey('ed25519:OLD')), policy, 1_000n)).toEqual({ kind: 'keys' })
    expect(checkDelegate(keys(addKey(), deleteKey('ed25519:OLD1'), deleteKey('ed25519:OLD2')), policy, 1_000n)).toEqual({ kind: 'keys' })
  })

  it('never adds a full-access key, a key for another contract or other methods', () => {
    expect(checkDelegate(keys(addKey({ full: true })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/session keys are added/) })
    expect(checkDelegate(keys(addKey({ receiverId: 'usdc.testnet' })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/pool.testnet only/) })
    expect(checkDelegate(keys(addKey({ methodNames: ['challenge', 'migrate'] })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/play methods/) })
    expect(checkDelegate(keys(addKey({ methodNames: [] })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/play methods/) })
  })

  it('only adds keys that cannot pay for their own transactions', () => {
    expect(checkDelegate(keys(addKey({ allowance: undefined })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/allowance/) })
    expect(checkDelegate(keys(addKey({ allowance: 250_000_000_000_000_000_000_000n })), policy, 1_000n)).toEqual({ error: expect.stringMatching(/allowance/) })
  })

  it('never touches the signing key, repeats a key, or mixes in calls', () => {
    expect(checkDelegate(keys(deleteKey('ed25519:SIGNER')), policy, 1_000n)).toEqual({ error: expect.stringMatching(/signing key/) })
    expect(checkDelegate(keys(addKey({}, 'ed25519:X'), deleteKey('ed25519:X')), policy, 1_000n)).toEqual({ error: expect.stringMatching(/twice/) })
    expect(checkDelegate(keys(addKey(), { functionCall: { methodName: 'claim', args: json({}), gas: TGAS, deposit: 0n } }), policy, 1_000n)).toEqual({ error: expect.stringMatching(/no calls/) })
    expect(checkDelegate(keys({}), policy, 1_000n)).toEqual({ error: expect.stringMatching(/only key changes/) })
  })

  it('adds one key at a time and bounds the deletions', () => {
    expect(checkDelegate(keys(addKey({}, 'ed25519:A'), addKey({}, 'ed25519:B')), policy, 1_000n)).toEqual({ error: expect.stringMatching(/one session key/) })
    const many = Array.from({ length: 6 }, (_, i) => deleteKey(`ed25519:K${i}`))
    expect(checkDelegate(keys(...many), policy, 1_000n)).toEqual({ error: expect.stringMatching(/too many/) })
  })
})
