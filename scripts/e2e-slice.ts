// End-to-end slice on the local chain, through the real relayer service:
// activation → sign-in (session key) → relayed deposits → challenge → settlement → claim →
// unbond and withdraw → sign-out. The identity provider and the wallet are simulated: a throwaway
// P-256 key stands in for Privy's token signer, and a local ed25519 key for the player's Privy
// wallet. Everything else (chain, contracts, relayer, signatures, nonces) is real.
//
//   cd contract && cargo run -p rugpool --example localnet -- --accounts 4 --port 3031
//   node --experimental-strip-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/e2e-slice.ts
//
// Writes .localnet/e2e-result.json. Exits non-zero on the first failed check.

import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Account, JsonRpcProvider, KeyPairEd25519, KeyPairSigner, actions, buildDelegateAction, type KeyPairString } from 'near-api-js'
import { fromWire } from '../src/near/relayWire.ts'
import { GAME_METHODS } from '../src/near/relayPolicy.ts'
import { parseRpcUrls, rpcProvider } from '../src/near/rpc.ts'
import { SessionSigner, relay, sessionKeyChange, sessionKeysOn, signAccountDelegate } from '../src/near/session.ts'
import { nearTransfers } from '../src/near/transfers.ts'

const USDC = 1_000_000n
const PORT = 8799
const RELAYER = `http://127.0.0.1:${PORT}`
const ln = JSON.parse(readFileSync('.localnet/localnet.json', 'utf8')) as { rpc: string; usdc: string; rugpool: string; relayer: string; keeper: string; player_key: KeyPairString }
const provider = rpcProvider([ln.rpc])
const keeperKey = JSON.parse(readFileSync(`.localnet/credentials/${ln.keeper}.json`, 'utf8')).private_key as KeyPairString
const keeper = new Account(ln.keeper, provider, keeperKey)
const result: { checks: Array<{ step: string; ok: boolean; detail?: unknown }>; startedAt: string; account?: string } = { checks: [], startedAt: new Date().toISOString() }

function check(step: string, ok: boolean, detail?: unknown): void {
  result.checks.push({ step, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail === undefined ? '' : ` ${JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`}`)
  if (!ok) finish(1)
}

let relayerProc: ReturnType<typeof spawn> | null = null
const extraProcs: Array<ReturnType<typeof spawn>> = []
process.on('exit', () => [relayerProc, ...extraProcs].forEach((p) => p?.kill()))
process.on('uncaughtException', (e) => {
  console.error(e)
  finish(1)
})
function finish(code: number): never {
  relayerProc?.kill()
  const bigints = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
  writeFileSync('.localnet/e2e-result.json', JSON.stringify({ ...result, finishedAt: new Date().toISOString(), passed: code === 0 }, bigints, 2))
  process.exit(code)
}

const view = async <T>(contractId: string, method: string, args: object = {}) => provider.callFunction<T & object>({ contractId, method, args }) as Promise<T>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Any failed receipt in a transaction outcome, as text. */
function failure(outcome: unknown): string | null {
  const o = outcome as { status?: unknown; receipts_outcome?: Array<{ outcome: { status: unknown } }> }
  for (const s of [o.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome.status)]) {
    if (typeof s === 'object' && s !== null && 'Failure' in s) return JSON.stringify(s)
  }
  return null
}

async function solvent(step: string): Promise<void> {
  const l = await view<Record<string, string>>(ln.rugpool, 'get_liabilities')
  const owed = Object.values(l).reduce((a, v) => a + BigInt(v), 0n)
  const held = BigInt(await view<string>(ln.usdc, 'ft_balance_of', { account_id: ln.rugpool }))
  check(`solvent after ${step}`, owed === held, { owed, held })
}

// --- a stand-in for Privy: an ES256 key that signs identity tokens -------------------------
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))
const privy = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', privy.publicKey))))}\n-----END PUBLIC KEY-----`
async function identityToken(userId: string, nearAccount: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const input = `${enc({ alg: 'ES256', typ: 'JWT' })}.${enc({ iss: 'privy.io', aud: 'e2e-app', sub: userId, iat: now, exp: now + 3600, linked_accounts: JSON.stringify([{ type: 'email', address: 'player@example.com' }, { type: 'wallet', chain_type: 'near', address: nearAccount }]) })}`
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privy.privateKey, new TextEncoder().encode(input)))
  return `${input}.${b64url(sig)}`
}

// --- the real relayer service ---------------------------------------------------------------
rmSync('.localnet/relayer-e2e', { recursive: true, force: true })
async function startRelayer(port: number, extraEnv: Record<string, string> = {}): Promise<ReturnType<typeof spawn>> {
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './scripts/ts-resolve.mjs', 'scripts/relayer.ts', ln.relayer, ln.rugpool, ln.usdc, String(port)], {
    env: { ...process.env, NEAR_RPC: ln.rpc, NEAR_CREDENTIALS_DIR: '.localnet/credentials', PRIVY_APP_ID: 'e2e-app', PRIVY_VERIFICATION_KEY: pem, RELAYER_DATA_DIR: '.localnet/relayer-e2e', ACTIVATION_NEAR: '0.005', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (d: Buffer) => {
      process.stdout.write(`  [relayer:${port}] ${d}`)
      if (d.toString().includes('relayer for')) resolve()
    })
    proc.on('exit', (code) => reject(new Error(`relayer exited with ${code}`)))
  })
  return proc
}
relayerProc = await startRelayer(PORT)
const postTo = async (base: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const post = (path: string, body: unknown) => postTo(RELAYER, path, body)

// --- the player ------------------------------------------------------------------------------
const wallet = KeyPairEd25519.fromRandom()
const player = Buffer.from(wallet.getPublicKey().data).toString('hex')
const walletSigner = new KeyPairSigner(wallet)
result.account = player
const nearBalance = async () => (await provider.viewAccount({ accountId: player, blockQuery: { finality: 'optimistic' } })).amount
const usdcWallet = async () => BigInt(await view<string>(ln.usdc, 'ft_balance_of', { account_id: player }))
const account = () => view<Record<string, string>>(ln.rugpool, 'get_account', { account_id: player })

// 1. Activation, bound to the login.
const token = await identityToken('did:privy:e2e-player', player)
const other = KeyPairEd25519.fromRandom()
const otherId = Buffer.from(other.getPublicKey().data).toString('hex')
check('activation refuses an account the login does not own', (await post('/activate', { idToken: token, accountId: otherId })).status === 403)
const act = await post('/activate', { idToken: token, accountId: player })
check('activation funds the new account', act.status === 200 && act.body.state === 'funded', act)
const activated = await nearBalance()
check('the account holds exactly the activation amount', activated === 5_000_000_000_000_000_000_000n, { activated })
check('a second activation sends nothing', (await post('/activate', { idToken: token, accountId: player })).body.state === 'already')

// The relayer recorded the transfer's identity before sending it, and that identity is the chain's.
const ledger = readFileSync('.localnet/relayer-e2e/activations.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { state: string; accountId: string; tx?: string; attempt?: { tx: string } })
const pendingRecord = ledger.find((r) => r.state === 'pending' && r.accountId === player)
const onChain = pendingRecord?.tx ? await provider.viewTransactionStatus({ txHash: pendingRecord.tx, accountId: ln.relayer, waitUntil: 'FINAL' }) : null
check('the activation transfer was recorded under the hash the chain gives it', !!onChain && onChain.transaction_outcome.id === pendingRecord?.tx && pendingRecord?.attempt?.tx === pendingRecord?.tx && onChain.transaction.receiver_id === player, { recorded: pendingRecord?.tx, chain: onChain?.transaction_outcome.id })

// Settling transfers from the chain, from an account the running relayer doesn't use.
const protocol = await provider.experimental_protocolConfig({ finality: 'final' })
const limits = { validityBlocks: BigInt(protocol.transaction_validity_period ?? 0), historyBlocks: 2n * BigInt(protocol.epoch_length ?? 0), retentionMarginBlocks: BigInt(protocol.epoch_length ?? 0) }
const transfers = nearTransfers(new Account('p2.sandbox', provider, ln.player_key), provider, limits)
const p1Balance = async () => (await provider.viewAccount({ accountId: 'p1.sandbox', blockQuery: { finality: 'final' } })).amount
const sentOk = await transfers.prepare('p1.sandbox', 3n)
check('a sent transfer settles as succeeded', (await sentOk.send()) === 'succeeded' && (await transfers.status(sentOk.attempt)) === 'succeeded')
const before = await p1Balance()
const neverSent = await transfers.prepare('p1.sandbox', 7n)
const recovered = await transfers.status(neverSent.attempt)
const again = await transfers.status(neverSent.attempt)
const credited = (await p1Balance()) - before
check('a transfer lost before sending is rebroadcast once and lands once', recovered === 'succeeded' && again === 'succeeded' && credited === 7n, { recovered, again, credited })
const superseded = await transfers.prepare('p1.sandbox', 11n)
const later = await transfers.prepare('p1.sandbox', 13n)
await later.send()
const before2 = await p1Balance()
const alone = await transfers.status(superseded.attempt)
check('with one endpoint, a transfer whose nonce a later one used stays unknown', alone === 'unknown', { alone })
// Two URLs for the one local node (the same URL twice is refused): this checks the confirming
// path, not that the endpoints are independent.
const alias = ln.rpc.replace('127.0.0.1', 'localhost')
if (alias === ln.rpc) throw new Error(`expected a 127.0.0.1 RPC URL, got ${ln.rpc}`)
const confirmed = nearTransfers(new Account('p2.sandbox', provider, ln.player_key), provider, limits, parseRpcUrls(`${ln.rpc},${alias}`).map((url) => new JsonRpcProvider({ url })))
const dead = await confirmed.status(superseded.attempt)
check('confirmed by a second endpoint, it settles as failed, and nothing is resent', dead === 'failed' && (await p1Balance()) === before2, { dead })

// The player's USDC arrives from outside (on mainnet, a NEAR Intents delivery or a transfer).
await keeper.callFunction({ contractId: ln.usdc, methodName: 'storage_deposit', args: { account_id: player }, gas: 10_000_000_000_000n, deposit: 10_000_000_000_000_000_000_000n })
await keeper.callFunction({ contractId: ln.usdc, methodName: 'mint', args: { account_id: player, amount: (60n * USDC).toString() }, gas: 10_000_000_000_000n })
check('the player has 60 tUSDC', (await usdcWallet()) === 60n * USDC)

// 2. Sign-in: the wallet adds a session key through the relayer.
const session = KeyPairEd25519.fromRandom()
const keyChange = await relay(RELAYER, await signAccountDelegate(provider, walletSigner, player, player, sessionKeyChange(ln.rugpool, session.getPublicKey(), [])))
check('sign-in adds the session key through the relayer', failure(keyChange) === null, failure(keyChange) ?? undefined)
const added = await provider.viewAccessKey({ accountId: player, publicKey: session.getPublicKey(), finalityQuery: { finality: 'optimistic' } })
const perm = typeof added.permission === 'object' ? added.permission.FunctionCall : null
check('the session key calls only the game, with a 1 yocto allowance', perm?.receiver_id === ln.rugpool && perm.allowance === '1' && perm.method_names.length === GAME_METHODS.length, perm)
try {
  await new Account(player, provider, session.toString() as KeyPairString).callFunction({ contractId: ln.rugpool, methodName: 'claim', args: {}, gas: 30_000_000_000_000n })
  check('the session key cannot pay for its own transaction', false)
} catch (e) {
  check('the session key cannot pay for its own transaction', /allowance|balance/i.test(String(e)), (e as Error).constructor.name)
}

// 3. Relayed deposits: 30 into the Court, 10 to the game balance.
const deposit = (amount: bigint, msg: object) => signAccountDelegate(provider, walletSigner, player, ln.usdc, [actions.functionCall('ft_transfer_call', { receiver_id: ln.rugpool, amount: amount.toString(), msg: JSON.stringify(msg) }, 100_000_000_000_000n, 1n)])
for (const [amount, msg] of [[30n * USDC, { action: 'join' }], [10n * USDC, { action: 'balance' }]] as const) {
  const out = await relay(RELAYER, await deposit(amount, msg))
  check(`relayed deposit of ${amount / USDC} (${msg.action})`, failure(out) === null, failure(out) ?? undefined)
}
let a = await account()
check('the deposits are credited', a.court === (30n * USDC).toString() && a.balance === (10n * USDC).toString(), a)
check('a deposit crediting someone else is refused', (await post('/relay', await signAccountDelegate(provider, walletSigner, player, ln.usdc, [actions.functionCall('ft_transfer_call', { receiver_id: ln.rugpool, amount: '1000000', msg: JSON.stringify({ action: 'balance', beneficiary: 'p1.sandbox' }) }, 100_000_000_000_000n, 1n)]))).status === 400)
await solvent('deposits')

// 4. Two other players buy first, then the player takes the throne last, past the $8 trigger.
const signer = new SessionSigner(provider, player, session)
for (const p of ['p1.sandbox', 'p2.sandbox']) {
  const acct = new Account(p, provider, ln.player_key)
  await acct.callFunction({ contractId: ln.usdc, methodName: 'ft_transfer_call', args: { receiver_id: ln.rugpool, amount: (10n * USDC).toString(), msg: '' }, gas: 100_000_000_000_000n, deposit: 1n })
  const price = (await view<{ round: { next_price: string } }>(ln.rugpool, 'get_state')).round.next_price
  await acct.callFunction({ contractId: ln.rugpool, methodName: 'challenge', args: { max_price: price }, gas: 100_000_000_000_000n })
}
const price = (await view<{ round: { next_price: string } }>(ln.rugpool, 'get_state')).round.next_price
const ch = await relay(RELAYER, await signer.sign(ln.rugpool, 'challenge', { max_price: price }, 100))
check('relayed challenge with the session key', failure(ch) === null, failure(ch) ?? undefined)
let state = await view<{ round: { king: string | null; jackpot: string; showdown_ends_at: number | null } }>(ln.rugpool, 'get_state')
check('the player is King and the showdown has started', state.round.king === player && state.round.showdown_ends_at !== null, state.round)
await solvent('challenges')

// 5. Settlement by the keeper once the showdown ends.
const jackpot = BigInt(state.round.jackpot)
const balanceBefore = BigInt((await account()).balance)
while (Date.now() < (state.round.showdown_ends_at ?? 0) + 3_000) await sleep(2_000)
const settle = await keeper.callFunction({ contractId: ln.rugpool, methodName: 'settle_round', args: {}, gas: 50_000_000_000_000n }).then(() => null, (e: unknown) => String(e))
check('the keeper settles the round', settle === null, settle ?? undefined)
a = await account()
check('the Jackpot is paid to the player', BigInt(a.balance) >= balanceBefore + jackpot, { jackpot, before: balanceBefore, after: a.balance })
await solvent('settlement')

// 6. Claim: game balance and earnings to the wallet.
const walletBefore = await usdcWallet()
const owedBefore = BigInt(a.balance) + BigInt(a.court_earned) + BigInt(a.king_stream)
const cl = await relay(RELAYER, await signer.sign(ln.rugpool, 'claim', {}, 100))
check('relayed claim', failure(cl) === null, failure(cl) ?? undefined)
const claimed = (await usdcWallet()) - walletBefore
check('the claim paid at least what the account showed', claimed >= owedBefore && claimed > 0n, { claimed, owedBefore })
await solvent('claim')

// 7. Unbond the Court deposit, wait out the cooldown, withdraw.
const rw = await relay(RELAYER, await signer.sign(ln.rugpool, 'request_withdraw', { amount: (30n * USDC).toString() }, 50))
check('relayed withdrawal request', failure(rw) === null, failure(rw) ?? undefined)
a = await account()
check('the Court deposit is pending', a.court === '0' && a.withdraw_pending === (30n * USDC).toString(), a)
while (Date.now() < Number(a.withdraw_ready_at) + 3_000) await sleep(2_000)
const w0 = await usdcWallet()
const wd = await relay(RELAYER, await signer.sign(ln.rugpool, 'withdraw', {}, 100))
check('relayed withdraw', failure(wd) === null, failure(wd) ?? undefined)
check('exactly 30 reached the wallet', (await usdcWallet()) - w0 === 30n * USDC)
await solvent('withdraw')

// 8. A thief with the session key relays a challenge themselves, past our relayer: the
// contract refuses spending calls relayed by anyone but the game's relayer.
const thief = new Account('p3.sandbox', provider, ln.player_key)
const stolen = await signer.sign(ln.rugpool, 'challenge', { max_price: (100n * USDC).toString() }, 100)
const selfRelayed = await thief.relayMetaTransaction(fromWire(stolen)).then(failure, (e: unknown) => String(e))
check('a challenge relayed by a stranger is refused on chain', /UNTRUSTED_RELAYER/.test(selfRelayed ?? ''), selfRelayed)

// 9. The thief pushes the stolen key's nonce up by self-relaying a claim (claims stay open to
// any relayer), so on chain the key looks freshly added. A relayer with a short session lifetime
// sharing the same key records still ages the key from its sign-in, and refuses it.
const height = BigInt((await provider.viewBlock({ finality: 'final' })).header.height)
const pushedNonce = height * 1_000_000n - 1_000n
const pushedClaim = await new KeyPairSigner(session).signDelegateAction(
  buildDelegateAction({ senderId: player, receiverId: ln.rugpool, actions: [actions.functionCall('claim', {}, 30_000_000_000_000n, 0n)], nonce: pushedNonce, maxBlockHeight: height + 100n, publicKey: session.getPublicKey() }),
)
await thief.relayMetaTransaction(pushedClaim.signedDelegate).catch(() => null)
const pushed = await provider.viewAccessKey({ accountId: player, publicKey: session.getPublicKey(), finalityQuery: { finality: 'optimistic' } })
check("the thief pushed the session key's nonce to look new", pushed.nonce === pushedNonce, { nonce: pushed.nonce, pushedNonce })
const shortLived = await startRelayer(PORT + 1, { SESSION_MAX_AGE_BLOCKS: '5' })
extraProcs.push(shortLived)
const aged = await postTo(`http://127.0.0.1:${PORT + 1}`, '/relay', await new SessionSigner(provider, player, session).sign(ln.rugpool, 'claim', {}, 50))
check('the relayer still ages the key from sign-in, not from its nonce', aged.status === 400 && /expired/.test(String(aged.body.error)), aged.body)
shortLived.kill()

// 10. Sign-out deletes the session key; the relayer then refuses an action it had signed.
const presigned = await signer.sign(ln.rugpool, 'claim', {}, 50)
const out = await relay(RELAYER, await signAccountDelegate(provider, walletSigner, player, player, sessionKeyChange(ln.rugpool, null, await sessionKeysOn(provider, player, ln.rugpool))))
check('sign-out deletes the session key through the relayer', failure(out) === null && (await sessionKeysOn(provider, player, ln.rugpool)).length === 0)
const after = await post('/relay', presigned)
check('an action signed by the deleted session key is refused', after.status === 400 && /session key/.test(String(after.body.error)), after.body)

// 11. The player never paid anything in NEAR: the relayer pays the gas and even the 1 yocto
// each deposit attaches (NEP-366: the relayer funds the inner actions' deposits).
const final = await nearBalance()
check("the player's NEAR is unchanged since activation", final === activated, { activated, final })
finish(0)
