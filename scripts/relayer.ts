// Gas relayer for RugPool. Players' browsers sign actions as NEP-366 delegate actions; this
// service checks them (src/near/relayHandler.ts) and submits them as meta transactions, paying
// the gas from the relayer account. It also activates each new Privy player's NEAR account once
// (src/near/activation.ts), so players never buy or hold NEAR.
//
//   node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/relayer.ts \
//     <relayer-account> <pool> <token> [port=8787] [allowed-origin=http://127.0.0.1:5187]
//
// Environment:
//   NEAR_RPC                  comma-separated RPC endpoints, tried in order, falling back when
//                             one fails. Defaults to the free public testnet endpoints on
//                             docs.near.org/api/rpc/providers (2026-11-09), the rate-limited
//                             archival one last. Activation settles each unknown transfer from
//                             one endpoint at a time, inside the history that endpoint reports.
//                             A URL listed twice is refused.
//   NEAR_CREDENTIALS_DIR      where <relayer-account>.json holds the relayer's key
//                             (default ~/.near-credentials/testnet; the local chain's is
//                             .localnet/credentials). Give the relayer its own account and key:
//                             anything else signing with that key moves its nonce.
//   PRIVY_APP_ID              enables /activate, with PRIVY_VERIFICATION_KEY: the app's public
//                             verification key (PEM), from the Privy dashboard
//   ACTIVATION_NEAR           balance an activated account is topped up to (default 0.005)
//   ACTIVATION_BUDGET_NEAR    most NEAR spent on activations per UTC day (default 1)
//   ACTIVATIONS_PER_IP        new accounts per IP per day (default 3)
//   SESSION_MAX_AGE_BLOCKS    session key lifetime (default 600000, about a week)
//   RELAYER_DATA_DIR          where the activation ledger and the session key births live
//                             (default .relayer). Keep it: losing it restarts every key's lifetime.
//   TRUST_PROXY=1             take the client IP from the last X-Forwarded-For entry; set it
//                             only behind a proxy that appends that header

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Account, JsonRpcProvider, parseNearAmount, type KeyPairString } from 'near-api-js'
import { createActivation, type ActivationRecord, type Ledger } from '../src/near/activation.ts'
import { importVerificationKey, verifyIdentityToken } from '../src/near/identity.ts'
import { parseJsonLines } from '../src/near/jsonLines.ts'
import { createRelayHandler, type KeyBirths } from '../src/near/relayHandler.ts'
import { GAME_METHODS } from '../src/near/relayPolicy.ts'
import { parseRpcUrls, rpcProvider } from '../src/near/rpc.ts'
import { nearTransfers } from '../src/near/transfers.ts'

const [relayerId, pool, token, port = '8787', origin = 'http://127.0.0.1:5187'] = process.argv.slice(2)
if (!relayerId || !pool || !token) throw new Error('usage: relayer.ts <relayer-account> <pool> <token> [port] [allowed-origin]')
const env = process.env
function near(v: string | undefined, fallback: `${number}`): bigint {
  const s = v ?? fallback
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a NEAR amount: ${s}`)
  return BigInt(parseNearAmount(s as `${number}`) ?? '0')
}

// Falls over to the next RPC when one fails, and passes the chain's own errors through (src/near/rpc.ts).
const rpcs = parseRpcUrls(env.NEAR_RPC ?? 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs,https://archival-rpc.testnet.near.org')
const provider = rpcProvider(rpcs)
const credentials = env.NEAR_CREDENTIALS_DIR ?? join(homedir(), '.near-credentials', 'testnet')
const key: KeyPairString = JSON.parse(readFileSync(join(credentials, `${relayerId}.json`), 'utf8')).private_key
const relayer = new Account(relayerId, provider, key)
const dataDir = env.RELAYER_DATA_DIR ?? '.relayer'
mkdirSync(dataDir, { recursive: true })

/** Append-only JSON lines, fsynced before `put` resolves. One relayer process owns each file. */
function jsonLines<T>(path: string): { all: T[]; put: (record: T) => Promise<void> } {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const { records: all, skippedTail } = parseJsonLines<T>(text)
  if (skippedTail !== null) {
    console.error(`${path}: dropped a partial last record from an interrupted write`)
    truncateSync(path, Buffer.byteLength(text) - Buffer.byteLength(skippedTail))
  }
  const fd = openSync(path, 'a')
  process.on('exit', () => closeSync(fd))
  return {
    all,
    put: async (r) => {
      writeSync(fd, `${JSON.stringify(r)}\n`)
      fsyncSync(fd)
      all.push(r)
    },
  }
}

function fileKeyBirths(path: string): KeyBirths {
  const lines = jsonLines<{ key: string; height: string }>(path)
  const births = new Map(lines.all.map((r) => [r.key, BigInt(r.height)]))
  return {
    get: (k) => births.get(k),
    record: async (k, h) => {
      await lines.put({ key: k, height: h.toString() })
      births.set(k, h)
    },
  }
}

const relay = createRelayHandler({
  policy: {
    pool,
    token,
    methods: GAME_METHODS,
    maxGas: 100_000_000_000_000n,
    maxTtlBlocks: 120n,
    sessionMaxAgeBlocks: BigInt(env.SESSION_MAX_AGE_BLOCKS ?? '600000'),
    maxKeyDeletes: 8,
  },
  height: async () => BigInt((await provider.viewBlock({ finality: 'final' })).header.height),
  accessKey: async (accountId, publicKey) => {
    try {
      const k = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'optimistic' } })
      const fc = typeof k.permission === 'object' ? k.permission.FunctionCall : null
      return { nonce: BigInt(k.nonce), permission: fc ? { receiverId: fc.receiver_id, methods: fc.method_names } : 'full' }
    } catch {
      return null
    }
  },
  keyBirths: fileKeyBirths(join(dataDir, 'session-keys.jsonl')),
  submit: (signed) =>
    relayer.relayMetaTransaction(signed).catch((e: unknown) => {
      console.error(`${new Date().toISOString()} submit failed:`, e instanceof Error ? `${e.constructor.name}: ${e.message}` : e)
      throw e
    }),
})

function fileLedger(path: string): Ledger {
  const lines = jsonLines<ActivationRecord>(path)
  return { all: () => lines.all, put: lines.put }
}

/**
 * How long a transfer stays valid, and how long an RPC endpoint can be trusted to remember one:
 * at most 2 epochs, and at least an epoch inside the history the endpoint reports (free public
 * endpoints were seen keeping from about 2 to 4 epochs).
 */
async function chainLimits() {
  const p = await provider.experimental_protocolConfig({ finality: 'final' })
  if (!p.transaction_validity_period || !p.epoch_length) throw new Error('The RPC did not report the transaction validity period and epoch length.')
  const epoch = BigInt(p.epoch_length)
  return { validityBlocks: BigInt(p.transaction_validity_period), historyBlocks: 2n * epoch, retentionMarginBlocks: epoch }
}

async function activationHandler() {
  if (!env.PRIVY_APP_ID || !env.PRIVY_VERIFICATION_KEY) return null
  const appId = env.PRIVY_APP_ID
  const verificationKey = await importVerificationKey(env.PRIVY_VERIFICATION_KEY)
  return createActivation({
    verify: (idToken) => verifyIdentityToken(idToken, verificationKey, appId, Math.floor(Date.now() / 1000)),
    balance: async (accountId) => {
      try {
        return (await provider.viewAccount({ accountId, blockQuery: { finality: 'optimistic' } })).amount
      } catch (e) {
        if (e instanceof Error && e.constructor.name === 'AccountDoesNotExistError') return null
        throw e
      }
    },
    transfers: nearTransfers(relayer, provider, await chainLimits(), rpcs.map((url) => new JsonRpcProvider({ url }))),
    ledger: fileLedger(join(dataDir, 'activations.jsonl')),
    target: near(env.ACTIVATION_NEAR, '0.005'),
    perIpPerDay: Number(env.ACTIVATIONS_PER_IP ?? '3'),
    dailyBudget: near(env.ACTIVATION_BUDGET_NEAR, '1'),
  })
}
const activate = await activationHandler()

function clientIp(req: IncomingMessage): string | undefined {
  if (env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for']
    const last = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',').pop()?.trim()
    if (last) return last
  }
  return req.socket.remoteAddress
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return void res.writeHead(204).end()
  const route = req.url === '/relay' ? relay : req.url === '/activate' && activate ? activate : null
  if (req.method !== 'POST' || !route) return void res.writeHead(404).end()
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 16_384) return void res.writeHead(413).end()
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return void res.writeHead(400, { 'Content-Type': 'application/json' }).end(json({ error: 'Not JSON.' }))
  }
  const ip = clientIp(req)
  const reply = await route(body, { ip }).catch((e: unknown) => {
    console.error(`${new Date().toISOString()} handler error:`, e instanceof Error ? e.message : e)
    return { status: 500, body: { error: 'The relayer hit an error.' } }
  })
  const who = typeof body === 'object' && body !== null ? ((body as { senderId?: unknown; accountId?: unknown }).senderId ?? (body as { accountId?: unknown }).accountId) : undefined
  console.log(`${new Date().toISOString()} ${req.url} ${JSON.stringify(who)} -> ${reply.status}${reply.body.error ? ` ${JSON.stringify(reply.body.error)}` : ''}`)
  res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(json(reply.body))
})
// Bound how long a client may take to send its request (slow-loris), not how long the relayer
// takes to answer: a relayed transaction can take 20s+ to reach final status, and cutting the
// socket then makes the browser resend the POST.
server.headersTimeout = 10_000
server.requestTimeout = 10_000
const host = env.RELAYER_HOST ?? '127.0.0.1'
server.listen(Number(port), host, () =>
  console.log(`relayer for ${pool} (token ${token}) as ${relayerId} on http://${host}:${port}, allowing ${origin}; activation ${activate ? 'on' : 'off (set PRIVY_APP_ID and PRIVY_VERIFICATION_KEY)'}`),
)
