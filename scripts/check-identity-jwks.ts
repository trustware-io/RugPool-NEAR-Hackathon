// Offline authentication checks. Every key/token is a locally generated fixture, NOT Privy-issued.
// Separate Node runner (not a Vitest-discovered *.test.ts file); no installed dependencies needed.
// Run: node --experimental-strip-types --import ./scripts/ts-resolve.mjs --test scripts/check-identity-jwks.ts
import { createActivation } from '../src/near/activation.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as identity from '../src/near/identity.ts'

const APP = 'cmvlfyqy601zk0gl8z783m96v'
const NOW = 1_800_000_000
const ACCOUNT = 'a'.repeat(64)
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const linked = [{ type: 'email', address: 'fixture@example.invalid' }, { type: 'wallet', chain_type: 'near', address: ACCOUNT }]
async function fixture(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'ES256', use: 'sig' }
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`
  async function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const input = `${enc({ alg: 'ES256', kid, ...header })}.${enc({ iss: 'privy.io', aud: APP, sub: 'did:privy:fixture', exp: NOW + 3600, iat: NOW - 10, linked_accounts: JSON.stringify(linked), ...claims })}`
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input))
    return `${input}.${Buffer.from(signature).toString('base64url')}`
  }
  return { jwk, pem, mint }
}
const a = await fixture('fixture-a')
const b = await fixture('fixture-b')

async function harness(keys: unknown[] = [a.jwk, b.jwk]) {
  let time = NOW * 1000
  let response: () => Response | Promise<Response> = () => Response.json({ keys })
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return response()
  }
  const verify = await identity.createIdentityVerifier(APP, { mode: 'jwks' }, { fetch: fetcher, now: () => time })
  return { verify, calls, advance: (ms: number) => { time += ms }, respond: (fn: typeof response) => { response = fn } }
}

test('both signing kids work; trusted endpoint ignores token key injection; cached fetch is shared', async () => {
  const h = await harness()
  const tokens = await Promise.all([a.mint({}, { jku: 'https://evil.invalid/keys', x5u: 'https://evil.invalid/cert', jwk: b.jwk }), b.mint()])
  for (const id of await Promise.all(tokens.map(h.verify))) assert.deepEqual(id, { userId: 'did:privy:fixture', nearAccounts: [ACCOUNT], hasEmail: true })
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].url, `https://api.privy.io/v1/apps/${APP}/jwks.json`)
  assert.equal(h.calls[0].init?.redirect, 'error')
  assert.equal(h.calls[0].init?.credentials, 'omit')
  assert.ok(h.calls[0].init?.signal instanceof AbortSignal)
})

test('rotation refreshes unknown kid after cooldown, limits misses, and expires removed cached keys', async () => {
  const h = await harness([a.jwk])
  await h.verify(await a.mint())
  h.respond(() => Response.json({ keys: [b.jwk] }))
  await assert.rejects(h.verify(await b.mint()), /key/)
  assert.equal(h.calls.length, 1)
  h.advance(30_001)
  await h.verify(await b.mint())
  assert.equal(h.calls.length, 2)
  await assert.rejects(h.verify(await a.mint()), /key/)
  h.advance(600_001)
  await h.verify(await b.mint())
  assert.equal(h.calls.length, 3)
})

test('rejects invalid alg, missing kid and unknown kid without accepting decoded claims', async () => {
  const h = await harness()
  for (const alg of ['none', 'HS256', 'RS256']) await assert.rejects(h.verify(await a.mint({}, { alg })), /algorithm/)
  for (const kid of [undefined, '', 4]) await assert.rejects(h.verify(await a.mint({}, { kid })), /kid/)
  assert.equal(h.calls.length, 0)
  await assert.rejects(h.verify(await a.mint({}, { kid: 'unknown' })), /key/)
  await assert.rejects(h.verify(await a.mint({}, { kid: 'unknown' })), /key/)
  assert.equal(h.calls.length, 1)
})

test('rejects wrong issuer, exact audience mismatch, expiry, future issuance, missing subject and bad signature', async () => {
  const h = await harness()
  for (const claims of [{ iss: 'evil.invalid' }, { aud: 'other-app' }, { aud: [APP] }, { exp: NOW - 31 }, { exp: NOW - 30 }, { exp: undefined }, { iat: NOW + 31 }, { sub: '' }]) {
    await assert.rejects(h.verify(await a.mint(claims)))
  }
  await assert.rejects(h.verify(await b.mint({}, { kid: a.jwk.kid })), /signature/)
  const [header, , signature] = (await a.mint()).split('.')
  await assert.rejects(h.verify(`${header}.${enc({ sub: 'tampered' })}.${signature}`), /signature/)
  await assert.rejects(h.verify(`${header}.${enc({})}.`), /signature/)
  for (const token of ['', 'a.b', 'a.b.c']) await assert.rejects(h.verify(token))
  await h.verify(await a.mint({ exp: NOW - 29 }))
})

test('preserves email detection, linked NEAR accounts, implicit account constraints and malformed-account refusal', async () => {
  const h = await harness()
  const id = await h.verify(await a.mint({ linked_accounts: JSON.stringify([
    { type: 'wallet', chain_type: 'near', address: 'B'.repeat(64) },
    { type: 'wallet', chain_type: 'ethereum', address: '0xabc' },
    { type: 'email', address: '' },
  ]) }))
  assert.deepEqual(id, { userId: 'did:privy:fixture', nearAccounts: ['b'.repeat(64)], hasEmail: false })
  assert.equal(identity.isImplicitAccount(id.nearAccounts[0]), true)
  for (const account of ['bob.testnet', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) assert.equal(identity.isImplicitAccount(account), false)
  await assert.rejects(h.verify(await a.mint({ linked_accounts: '{' })), /linked accounts/)
})

test('fails closed for invalid, empty, ambiguous, oversized or unavailable JWKS; no stale fallback', async () => {
  for (const body of [{}, { keys: [] }, { keys: [a.jwk, a.jwk] }, { keys: [{ ...a.jwk, crv: 'P-384' }] }, { keys: [{ ...a.jwk, use: 'enc' }] }, { keys: [{ ...a.jwk, alg: 'HS256' }] }, { keys: [{ ...a.jwk, x: 'invalid' }] }]) {
    const h = await harness()
    h.respond(() => Response.json(body))
    await assert.rejects(h.verify(await a.mint()))
  }
  for (const response of [() => new Response('no', { status: 503 }), () => new Response('{'), () => new Response(' '.repeat(65_537)), () => { throw new Error('fixture network failure') }]) {
    const h = await harness()
    await h.verify(await a.mint())
    h.advance(600_001)
    h.respond(response)
    await assert.rejects(h.verify(await a.mint()))
    await assert.rejects(h.verify(await a.mint()))
    assert.equal(h.calls.length, 2)
  }
})

test('fetch timeout aborts and rejects a stalled response body (fake clock, no sockets)', async (t) => {
  const token = await a.mint()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let signal: AbortSignal | null | undefined
  const fetcher: typeof fetch = async (_url, init) => {
    signal = init?.signal
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('fixture timeout')), { once: true })
        started()
      },
    }))
  }
  const verify = await identity.createIdentityVerifier(APP, { mode: 'jwks' }, { fetch: fetcher, now: () => NOW * 1000 })
  const rejected = assert.rejects(verify(token), /timeout/)
  await ready
  t.mock.timers.tick(5_000)
  await rejected
  assert.equal(signal?.aborted, true)
})

test('activation still denies guest, unlinked and malformed accounts; bad auth never reaches balance or transfers', async () => {
  const h = await harness()
  let balances = 0
  const forbidden = async (): Promise<never> => { throw new Error('no fixture transfer may occur') }
  const activate = createActivation({
    verify: h.verify,
    balance: async () => { balances++; return 10n },
    transfers: { prepare: forbidden, status: forbidden },
    ledger: { all: () => [], put: async () => {} },
    target: 10n, perIpPerDay: 1, dailyBudget: 10n, now: () => NOW * 1000,
  })
  assert.equal((await activate({ accountId: ACCOUNT, idToken: await a.mint({ linked_accounts: JSON.stringify(linked.slice(1)) }) })).status, 403)
  assert.equal((await activate({ accountId: 'b'.repeat(64), idToken: await a.mint() })).status, 403)
  assert.equal((await activate({ accountId: 'bob.testnet', idToken: await a.mint() })).status, 400)
  assert.equal((await activate({ accountId: ACCOUNT, idToken: await b.mint({}, { kid: a.jwk.kid }) })).status, 401)
  assert.equal(balances, 0)
  assert.equal((await activate({ accountId: ACCOUNT, idToken: await a.mint() })).status, 200)
  assert.equal(balances, 1)
})

test('explicit PEM mode remains offline; invalid mode/app configuration has no fallback', async () => {
  const noFetch: typeof fetch = async () => { throw new Error('must not fetch') }
  const verify = await identity.createIdentityVerifier(APP, { mode: 'pem', pem: a.pem }, { fetch: noFetch, now: () => NOW * 1000 })
  await verify(await a.mint())
  await assert.rejects(verify(await b.mint()), /signature/)
  await assert.rejects(identity.createIdentityVerifier(APP, { mode: 'invalid' } as never))
  await assert.rejects(identity.createIdentityVerifier(APP, { mode: 'pem', pem: '' }))
  for (const app of ['', '../evil', 'app?url=evil', 'https://evil.invalid']) await assert.rejects(identity.createIdentityVerifier(app, { mode: 'jwks' }))
})
