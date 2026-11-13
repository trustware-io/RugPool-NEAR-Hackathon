// What the gas relayer agrees to pay for. Players sign delegate actions (NEP-366); the relayer
// wraps and submits them at its own expense, so it forwards only three shapes:
//
// - game:    one zero-deposit call to a play method of the game contract, signed with the
//            player's session key (a function-call key the relayer checks on chain);
// - deposit: one `ft_transfer_call` of USDC to the game contract for the player's own account,
//            signed with the player's full-access key (their Privy wallet), 1 yoctoNEAR attached;
// - keys:    on the player's own account, add one session key (game methods only, an allowance
//            of 1 yoctoNEAR so it can't pay for transactions itself) and/or delete other session
//            keys; signed with the full-access key. This is sign-in, key reuse and sign-out.

/** The parts of a near-api-js `DelegateAction` the policy reads. */
export interface DelegateLike {
  senderId: string
  receiverId: string
  maxBlockHeight: bigint
  publicKey: { toString(): string }
  actions: Array<{
    functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
    addKey?: {
      publicKey: { toString(): string }
      accessKey: { permission: { functionCall?: { receiverId: string; methodNames: string[]; allowance?: bigint }; fullAccess?: unknown } }
    }
    deleteKey?: { publicKey: { toString(): string } }
  }>
}

export interface RelayPolicy {
  /** The game contract. */
  pool: string
  /** The USDC token deposits are paid in. */
  token: string
  methods: readonly string[]
  /** Gas the relayer will attach per call; a full auto-defend war measured 10 Tgas. */
  maxGas: bigint
  /** How far past the current block a delegate action may stay valid. */
  maxTtlBlocks: bigint
  /** Session keys older than this are refused; the player signs in again for a new one. */
  sessionMaxAgeBlocks: bigint
  /** Most session keys one key change may delete. */
  maxKeyDeletes: number
}

export type RelayKind = 'game' | 'deposit' | 'keys'

export const GAME_METHODS = ['challenge', 'set_auto_defend', 'join_court', 'request_withdraw', 'withdraw', 'claim'] as const

/**
 * A session key's allowance: too little to pay for any transaction, so the key works only
 * through the relayer, which enforces its expiry. Delegate actions don't draw on it.
 */
export const SESSION_KEY_ALLOWANCE = 1n

/** What a deposit's `msg` may ask for: credit the player's own balance, or join the Court. */
const DEPOSIT_ACTIONS = ['balance', 'join']

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function checkDepositArgs(args: Uint8Array, policy: RelayPolicy, sender: string): string | null {
  const a = decodeJson(args)
  if (!isObject(a) || Object.keys(a).some((k) => !['receiver_id', 'amount', 'msg', 'memo'].includes(k))) return 'unexpected deposit arguments'
  if (a.receiver_id !== policy.pool) return `deposits go to ${policy.pool}`
  if (typeof a.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(a.amount)) return 'invalid deposit amount'
  if (a.msg === undefined || a.msg === '') return null
  if (typeof a.msg !== 'string') return 'invalid deposit message'
  let msg: unknown
  try {
    msg = JSON.parse(a.msg)
  } catch {
    return 'invalid deposit message'
  }
  if (!isObject(msg) || Object.keys(msg).some((k) => !['action', 'beneficiary'].includes(k))) return 'invalid deposit message'
  if (typeof msg.action !== 'string' || !DEPOSIT_ACTIONS.includes(msg.action)) return 'deposits only credit the balance or join the Court'
  if (msg.beneficiary !== undefined && msg.beneficiary !== sender) return 'relayed deposits credit the sender only'
  return null
}

function checkKeyChanges(d: DelegateLike, policy: RelayPolicy): string | null {
  if (d.actions.length > 1 + policy.maxKeyDeletes) return 'too many key changes'
  let adds = 0
  const seen = new Set<string>()
  for (const a of d.actions) {
    if (a.functionCall) return 'a key change carries no calls'
    const target = (a.addKey ?? a.deleteKey)?.publicKey.toString()
    if (!target) return 'only key changes are relayed to the account itself'
    if (seen.has(target)) return 'a key appears twice'
    seen.add(target)
    if (target === d.publicKey.toString()) return 'the signing key cannot be changed'
    if (a.addKey) {
      adds++
      const fc = a.addKey.accessKey.permission.functionCall
      if (!fc) return 'only session keys are added'
      if (fc.receiverId !== policy.pool) return `session keys call ${policy.pool} only`
      if (fc.methodNames.length === 0 || fc.methodNames.some((m) => !policy.methods.includes(m))) return 'session keys call play methods only'
      if (fc.allowance !== SESSION_KEY_ALLOWANCE) return 'session keys carry the relay-only allowance'
    }
  }
  return adds > 1 ? 'one session key at a time' : null
}

/** Classifies a delegate action and applies its kind's static rules (the handler checks keys on chain). */
export function checkDelegate(d: DelegateLike, policy: RelayPolicy, currentHeight: bigint): { kind: RelayKind } | { error: string } {
  if (d.maxBlockHeight <= currentHeight) return { error: 'expired' }
  if (d.maxBlockHeight > currentHeight + policy.maxTtlBlocks) return { error: 'expiry is too far ahead' }
  if (d.actions.length === 0) return { error: 'no actions' }

  if (d.receiverId === d.senderId) {
    const error = checkKeyChanges(d, policy)
    return error ? { error } : { kind: 'keys' }
  }
  if (d.actions.length !== 1) return { error: 'exactly one action per relay' }
  const call = d.actions[0]?.functionCall
  if (!call) return { error: 'only function calls are relayed to contracts' }
  if (call.gas > policy.maxGas) return { error: `gas ${call.gas} is over ${policy.maxGas}` }

  if (d.receiverId === policy.pool) {
    if (!policy.methods.includes(call.methodName)) return { error: `method ${call.methodName} is not relayed` }
    if (call.deposit !== 0n) return { error: 'calls with a deposit are not relayed' }
    return { kind: 'game' }
  }
  if (d.receiverId === policy.token) {
    if (call.methodName !== 'ft_transfer_call') return { error: `method ${call.methodName} is not relayed` }
    if (call.deposit !== 1n) return { error: 'a deposit attaches exactly 1 yoctoNEAR' }
    const error = checkDepositArgs(call.args, policy, d.senderId)
    return error ? { error } : { kind: 'deposit' }
  }
  return { error: `receiver ${d.receiverId} is not relayed` }
}
