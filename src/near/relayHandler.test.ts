import { describe, expect, it } from 'vitest'
import { KeyPairEd25519, KeyPairSigner, PublicKey, actions, type Provider, type SignedDelegate } from 'near-api-js'
import type { WireDelegate } from './relayWire'
import { createRelayHandler, sourceOf, type KeyBirths, type KeyPermission, type RelayDeps } from './relayHandler'
import { GAME_METHODS, type RelayPolicy } from './relayPolicy'
import { SessionSigner, sessionKeyChange, signAccountDelegate } from './session'

const policy: RelayPolicy = {
  pool: 'pool.testnet',
  token: 'usdc.testnet',
  methods: GAME_METHODS,
  maxGas: 100_000_000_000_000n,
  maxTtlBlocks: 120n,
  sessionMaxAgeBlocks: 500n,
  maxKeyDeletes: 4,
}
const HEIGHT = 1_000n
/** A session key added at block 800: nonce (800 − 1) × 1e6 plus seven uses. */
const SESSION_NONCE = 799_000_007n
const sessionKey = async () => ({ nonce: SESSION_NONCE, permission: { receiverId: 'pool.testnet', methods: [] as string[] } as KeyPermission })

/** A submit that waits until released; releasing before it's called lets it through at once. */
function gate() {
  let open = false
  let waiting: Array<() => void> = []
  let calls = 0
  return {
    calls: () => calls,
    release: () => {
      open = true
      waiting.forEach((w) => w())
      waiting = []
    },
    submit: () => {
      calls++
      return open ? Promise.resolve({ status: { SuccessValue: '' } }) : new Promise((r) => waiting.push(() => r({ status: { SuccessValue: '' } })))
    },
  }
}

function births(initial: Record<string, bigint> = {}): KeyBirths & { all: Map<string, bigint> } {
  const all = new Map(Object.entries(initial))
  return { all, get: (k) => all.get(k), record: async (k, h) => void all.set(k, h) }
}

function handler(over: Partial<Omit<RelayDeps, 'keyBirths'>> & { keyBirths?: ReturnType<typeof births> } = {}) {
  let submits = 0
  const submitted: SignedDelegate[] = []
  const keyBirths = over.keyBirths ?? births()
  const handle = createRelayHandler({
    policy,
    accessKey: sessionKey,
    height: async () => HEIGHT,
    submit: async (s) => (submits++, submitted.push(s), { status: { SuccessValue: '' } }),
    ...over,
    keyBirths,
  })
  return { handle, submitted, submits: () => submits, keyBirths }
}

/** A stand-in RPC for signing: the signing key's nonce and the current block. */
function chain(nonce = SESSION_NONCE): Provider {
  return { viewAccessKey: async () => ({ nonce, permission: 'FullAccess' }), viewBlock: async () => ({ header: { height: Number(HEIGHT) } }) } as unknown as Provider
}

function signer(nonce = SESSION_NONCE, account = 'bob.testnet'): SessionSigner {
  return new SessionSigner(chain(nonce), account, KeyPairEd25519.fromRandom())
}

/** The player's own key (their Privy wallet) signing a deposit or a key change. */
const accountKey = KeyPairEd25519.fromRandom()
const fullKey = async () => ({ nonce: 5n, permission: 'full' as KeyPermission })
const signFull = (receiverId: string, acts: Parameters<typeof signAccountDelegate>[4]) => signAccountDelegate(chain(5n), new KeyPairSigner(accountKey), 'bob.testnet', receiverId, acts)
const depositCall = (msg: object) => actions.functionCall('ft_transfer_call', { receiver_id: 'pool.testnet', amount: '5000000', msg: JSON.stringify(msg) }, 100_000_000_000_000n, 1n)

describe('relay handler: game calls', () => {
  it('submits a valid game call and returns its outcome', async () => {
    const h = handler()
    const reply = await h.handle(await signer().sign('pool.testnet', 'challenge', { max_price: '5' }, 100))
    expect(reply).toEqual({ status: 200, body: { outcome: { status: { SuccessValue: '' } } } })
    expect(h.submitted[0]?.delegateAction.senderId).toBe('bob.testnet')
  })

  it('refuses garbage, other receivers and expired actions without submitting', async () => {
    const h = handler()
    expect((await h.handle({ hello: 'world' })).status).toBe(400)
    expect((await h.handle(await signer().sign('other.testnet', 'ft_transfer', {}, 30))).body.error).toMatch(/receiver/)
    const late = handler({ height: async () => 2_000n })
    expect((await late.handle(await signer().sign('pool.testnet', 'claim', {}, 60))).body.error).toBe('expired')
    expect(h.submits() + late.submits()).toBe(0)
  })

  it('refuses what the chain would reject, so nobody can make the relayer pay for failures', async () => {
    const valid = await signer().sign('pool.testnet', 'claim', {}, 60)
    const tampered: WireDelegate = { ...valid, actions: [{ ...(valid.actions[0] as Extract<WireDelegate['actions'][number], { type: 'call' }>), methodName: 'challenge' }] }
    const cases: Array<[Parameters<typeof handler>[0], WireDelegate, RegExp]> = [
      [{}, tampered, /bad signature/],
      [{ accessKey: fullKey }, valid, /session key/],
      [{ accessKey: async () => null }, valid, /session key/],
      [{ accessKey: async () => ({ nonce: SESSION_NONCE + 1n, permission: { receiverId: 'pool.testnet', methods: [] } }) }, valid, /nonce already used/],
      [{ accessKey: async () => ({ nonce: SESSION_NONCE, permission: { receiverId: 'pool.testnet', methods: ['challenge'] } }) }, valid, /session key/],
      [{ accessKey: async () => ({ nonce: SESSION_NONCE, permission: { receiverId: 'usdc.testnet', methods: [] } }) }, valid, /session key/],
    ]
    for (const [deps, body, error] of cases) {
      const h = handler(deps)
      expect((await h.handle(body)).body.error).toMatch(error)
      expect(h.submits()).toBe(0)
    }
  })

  it('refuses a session key older than the session lifetime', async () => {
    // Added at block 400, 600 blocks ago; the lifetime is 500.
    const key = KeyPairEd25519.fromRandom()
    const old = handler({ keyBirths: births({ [`bob.testnet/${key.getPublicKey()}`]: 400n }) })
    expect((await old.handle(await new SessionSigner(chain(), 'bob.testnet', key).sign('pool.testnet', 'claim', {}, 60))).body.error).toMatch(/expired; sign in again/)
    expect(old.submits()).toBe(0)
  })

  it('ages a key from its recorded birth even when its nonce was pushed up (a thief self-relaying claims)', async () => {
    const key = KeyPairEd25519.fromRandom()
    // On chain the key's nonce now looks like a key added this block.
    const pushed = 999_000_000n
    const h = handler({ keyBirths: births({ [`bob.testnet/${key.getPublicKey()}`]: 400n }), accessKey: async () => ({ nonce: pushed, permission: { receiverId: 'pool.testnet', methods: [] } }) })
    expect((await h.handle(await new SessionSigner(chain(pushed), 'bob.testnet', key).sign('pool.testnet', 'claim', {}, 60))).body.error).toMatch(/expired/)
    expect(h.submits()).toBe(0)
  })

  it('records a key it never saw added at the height its nonce implies', async () => {
    const h = handler()
    expect((await h.handle(await signer().sign('pool.testnet', 'claim', {}, 60))).status).toBe(200)
    expect([...h.keyBirths.all.values()]).toEqual([SESSION_NONCE / 1_000_000n])
  })

  it('refuses an old key it never recorded, instead of treating it as new (a lost key store)', async () => {
    // Added at block 400 by its nonce; nothing recorded; the lifetime is 500 and it's block 1000.
    const old = handler({ accessKey: async () => ({ nonce: 399_000_003n, permission: { receiverId: 'pool.testnet', methods: [] } }) })
    expect((await old.handle(await signer(399_000_003n).sign('pool.testnet', 'claim', {}, 60))).body.error).toMatch(/expired/)
    expect(old.submits()).toBe(0)
  })

  it('refuses a replay while the original is still in flight', async () => {
    const g = gate()
    const h = handler({ submit: g.submit })
    const valid = await signer().sign('pool.testnet', 'claim', {}, 60)
    const first = h.handle(valid)
    // Same nonce, different action (so a different signature): refused.
    const forged = await signer().sign('pool.testnet', 'claim', { x: 1 }, 60)
    expect((await h.handle({ ...forged, senderId: valid.senderId, publicKey: valid.publicKey, nonce: valid.nonce })).body.error).toMatch(/nonce already used|bad signature/)
    g.release()
    expect((await first).status).toBe(200)
  })

  it('answers an exact resend with the original result instead of a refusal', async () => {
    const g = gate()
    const h = handler({ submit: g.submit })
    const valid = await signer().sign('pool.testnet', 'claim', {}, 60)
    const first = h.handle(valid)
    const resend = h.handle(JSON.parse(JSON.stringify(valid)))
    g.release()
    expect(await resend).toEqual(await first)
    expect((await first).status).toBe(200)
    expect(g.calls()).toBe(1)
  })

  it('refuses absurd nonces that would jam the queue', async () => {
    const h = handler({ accessKey: async () => ({ nonce: 5_000_000_000n, permission: { receiverId: 'pool.testnet', methods: [] } }) })
    expect((await h.handle(await signer(5_000_000_000n).sign('pool.testnet', 'claim', {}, 60))).body.error).toBe('nonce too large')
  })

  it('a failed submit leaves the player able to retry', async () => {
    let fail = true
    const h = handler({ submit: async () => (fail ? Promise.reject(new Error('rpc down https://key@rpc')) : { status: { SuccessValue: '' } }) })
    const valid = await signer().sign('pool.testnet', 'claim', {}, 60)
    const reply = await h.handle(valid)
    expect(reply.status).toBe(502)
    expect(reply.body.error).not.toMatch(/rpc/)
    fail = false
    expect((await h.handle(valid)).status).toBe(200)
  })

  it("submits one player's actions in order even when they arrive together", async () => {
    const order: string[] = []
    const h = handler({
      submit: async (s) => {
        // The first submission is slower; it must still finish first.
        await new Promise((r) => setTimeout(r, s.delegateAction.nonce === SESSION_NONCE + 1n ? 30 : 0))
        order.push(s.delegateAction.nonce.toString())
        return { status: { SuccessValue: '' } }
      },
    })
    const sig = signer()
    const [a, b] = [await sig.sign('pool.testnet', 'set_auto_defend', { max_price: '6' }, 30), await sig.sign('pool.testnet', 'set_auto_defend', { max_price: '7' }, 30)]
    await Promise.all([h.handle(a), h.handle(b)])
    expect(order).toEqual([(SESSION_NONCE + 1n).toString(), (SESSION_NONCE + 2n).toString()])
  })

  it('rate-limits each player and each IP', async () => {
    let t = 0
    const h = handler({ now: () => t, perMinute: 2, perIpMinute: 3 })
    const sig = signer()
    expect((await h.handle(await sig.sign('pool.testnet', 'claim', {}, 60))).status).toBe(200)
    expect((await h.handle(await sig.sign('pool.testnet', 'claim', {}, 60))).status).toBe(200)
    expect((await h.handle(await sig.sign('pool.testnet', 'claim', {}, 60))).status).toBe(429)
    t = 60_001
    expect((await h.handle(await sig.sign('pool.testnet', 'claim', {}, 60))).status).toBe(200)
    // Many players behind one IP share its limit.
    const ip = { ip: '203.0.113.9' }
    const replies = []
    for (let i = 0; i < 4; i++) replies.push((await h.handle(await signer(SESSION_NONCE, `p${i}.testnet`).sign('pool.testnet', 'claim', {}, 60), ip)).status)
    expect(replies).toEqual([200, 200, 200, 429])
  })

  it('limits a burst sent all at once exactly like a stream', async () => {
    const h = handler({ perMinute: 2 })
    const sig = signer()
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => sig.sign('pool.testnet', 'claim', {}, 60)))
    const statuses = (await Promise.all(burst.map((b) => h.handle(b)))).map((r) => r.status)
    expect(statuses.filter((x) => x === 200)).toHaveLength(2)
    expect(statuses.filter((x) => x === 429)).toHaveLength(3)
    expect(h.submits()).toBe(2)
  })

  it("doesn't let unsigned requests naming a player use up that player's quota", async () => {
    const h = handler({ perMinute: 2, perMinuteTotal: 3 })
    const sig = signer()
    const valid = await sig.sign('pool.testnet', 'claim', {}, 60)
    // Ten forgeries in the player's name: a valid shape, someone else's signature.
    const forged = await Promise.all(Array.from({ length: 10 }, () => signer().sign('pool.testnet', 'claim', {}, 60)))
    for (const f of forged) expect((await h.handle({ ...f, publicKey: valid.publicKey, nonce: String(BigInt(valid.nonce) + 50n) })).body.error).toBe('bad signature')
    expect((await h.handle(valid)).status).toBe(200)
  })

  it("doesn't let requests signed by someone else's key use up a player's quota", async () => {
    // The attacker signs properly with their own key but names the player's account; the chain
    // has no such key on the player's account.
    const mine = KeyPairEd25519.fromRandom()
    const h = handler({ perMinute: 2, perMinuteTotal: 3, accessKey: async (_a, pk) => (pk === mine.getPublicKey().toString() ? await sessionKey() : null) })
    for (let i = 0; i < 10; i++) expect((await h.handle(await signer().sign('pool.testnet', 'claim', {}, 60))).body.error).toMatch(/session key/)
    expect((await h.handle(await new SessionSigner(chain(), 'bob.testnet', mine).sign('pool.testnet', 'claim', {}, 60))).status).toBe(200)
  })

  it('shares one IP bucket across requests with no known IP', async () => {
    const noIp = handler({ perIpMinute: 2 })
    const replies = []
    for (let i = 0; i < 3; i++) replies.push((await noIp.handle(await signer(SESSION_NONCE, `n${i}.testnet`).sign('pool.testnet', 'claim', {}, 60))).status)
    expect(replies).toEqual([200, 200, 429])
  })

  it('limits an IPv6 network by its /64, so rotating addresses within it does not help', async () => {
    const h = handler({ perIpMinute: 2 })
    const replies = []
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd']) {
      replies.push((await h.handle(await signer(SESSION_NONCE, `${ip.length}x${replies.length}.testnet`).sign('pool.testnet', 'claim', {}, 60), { ip })).status)
    }
    expect(replies).toEqual([200, 200, 429])
    expect(sourceOf('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(sourceOf('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64')
    expect(sourceOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('refuses a lower nonce that arrives behind a higher one, instead of paying for its failure', async () => {
    // The chain's view of the key follows each submit.
    let chainNonce = SESSION_NONCE
    let submits = 0
    const h = handler({
      accessKey: async () => ({ nonce: chainNonce, permission: { receiverId: 'pool.testnet', methods: [] } }),
      submit: async (s) => (submits++, (chainNonce = s.delegateAction.nonce), { status: { SuccessValue: '' } }),
    })
    const sig = signer()
    const [low, high] = [await sig.sign('pool.testnet', 'claim', {}, 60), await sig.sign('pool.testnet', 'claim', {}, 60)]
    const [highReply, lowReply] = await Promise.all([h.handle(high), h.handle(low)])
    expect(highReply.status).toBe(200)
    expect(lowReply.body.error).toBe('nonce already used')
    expect(submits).toBe(1)
  })

  it('caps requests in flight across everyone', async () => {
    const g = gate()
    const h = handler({ maxInflight: 1, submit: g.submit })
    const first = h.handle(await signer(SESSION_NONCE, 'a.testnet').sign('pool.testnet', 'claim', {}, 60))
    expect((await h.handle(await signer(SESSION_NONCE, 'b.testnet').sign('pool.testnet', 'claim', {}, 60))).status).toBe(429)
    g.release()
    expect((await first).status).toBe(200)
  })

  it('returns the outcome of a failed transaction so the app can show the refusal', async () => {
    const failed = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: PAUSED: paused' } } } } } }
    const h = handler({ submit: async () => Promise.reject(Object.assign(new Error('failed'), { transactionResult: failed })) })
    expect(await h.handle(await signer().sign('pool.testnet', 'challenge', { max_price: '5' }, 100))).toEqual({ status: 200, body: { outcome: failed } })
  })
})

describe('relay handler: deposits and key changes signed with the account key', () => {
  it("relays the player's own deposit, so the player needs no NEAR for gas", async () => {
    const h = handler({ accessKey: fullKey })
    expect((await h.handle(await signFull('usdc.testnet', [depositCall({ action: 'join' })]))).status).toBe(200)
    expect(h.submitted[0]?.delegateAction.receiverId).toBe('usdc.testnet')
  })

  it('refuses a deposit or key change signed with a session key', async () => {
    const h = handler()
    const deposit = await signAccountDelegate(chain(), new KeyPairSigner(KeyPairEd25519.fromRandom()), 'bob.testnet', 'usdc.testnet', [depositCall({ action: 'balance' })])
    expect((await h.handle(deposit)).body.error).toMatch(/account key/)
    const change = await signAccountDelegate(chain(), new KeyPairSigner(KeyPairEd25519.fromRandom()), 'bob.testnet', 'bob.testnet', sessionKeyChange('pool.testnet', KeyPairEd25519.fromRandom().getPublicKey(), []))
    expect((await h.handle(change)).body.error).toMatch(/account key/)
    expect(h.submits()).toBe(0)
  })

  it('adds a session key and deletes stale session keys in one change, and records the new key\'s birth', async () => {
    const stale = KeyPairEd25519.fromRandom().getPublicKey()
    const added = KeyPairEd25519.fromRandom().getPublicKey()
    const keys = new Map<string, { nonce: bigint; permission: KeyPermission }>([[stale.toString(), { nonce: 1n, permission: { receiverId: 'pool.testnet', methods: [...GAME_METHODS] } }]])
    const h = handler({ accessKey: async (_a, pk) => keys.get(pk) ?? (await fullKey()) })
    const reply = await h.handle(await signFull('bob.testnet', sessionKeyChange('pool.testnet', added, [stale])))
    expect(reply.status).toBe(200)
    expect(h.keyBirths.get(`bob.testnet/${added.toString()}`)).toBe(HEIGHT)
  })

  it('never deletes a full-access key, another contract\'s key, or a missing key', async () => {
    const target = KeyPairEd25519.fromRandom().getPublicKey()
    const lookups: Array<{ nonce: bigint; permission: KeyPermission } | null> = [
      { nonce: 1n, permission: 'full' },
      { nonce: 1n, permission: { receiverId: 'usdc.testnet', methods: [] } },
      null,
    ]
    for (const found of lookups) {
      const h = handler({ accessKey: async (_a, pk) => (pk === target.toString() ? found : await fullKey()) })
      expect((await h.handle(await signFull('bob.testnet', sessionKeyChange('pool.testnet', null, [target])))).body.error).toMatch(/only session keys/)
      expect(h.submits()).toBe(0)
    }
  })

  it('refuses a deposit that credits another account', async () => {
    const h = handler({ accessKey: fullKey })
    const reply = await h.handle(await signFull('usdc.testnet', [depositCall({ action: 'balance', beneficiary: 'mallory.testnet' })]))
    expect(reply.body.error).toMatch(/sender only/)
    expect(h.submits()).toBe(0)
  })

  it('carries key changes over the wire byte for byte', async () => {
    const pk = PublicKey.fromString(KeyPairEd25519.fromRandom().getPublicKey().toString())
    const wire = await signFull('bob.testnet', sessionKeyChange('pool.testnet', pk, []))
    expect(wire.actions).toEqual([{ type: 'addKey', publicKey: pk.toString(), receiverId: 'pool.testnet', methodNames: [...GAME_METHODS], allowance: '1' }])
    expect((await handler({ accessKey: fullKey }).handle(wire)).status).toBe(200)
  })
})
