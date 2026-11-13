// Tokens here are minted with a throwaway P-256 key standing in for Privy's: the checks are
// real, the identity provider is simulated. A real Privy token is checked in the browser run.

import { describe, expect, it } from 'vitest'
import { importVerificationKey, isImplicitAccount, verifyIdentityToken } from './identity'

const APP = 'app-123'
const NOW = 1_800_000_000
const ACCOUNT = 'a'.repeat(64)

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))

export async function privyKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki)).replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`
  async function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'ES256', typ: 'JWT' }): Promise<string> {
    const body = {
      iss: 'privy.io',
      aud: APP,
      sub: 'did:privy:user1',
      iat: NOW - 10,
      exp: NOW + 3600,
      linked_accounts: JSON.stringify([
        { type: 'email', address: 'player@example.com' },
        { type: 'wallet', chain_type: 'near', address: ACCOUNT, wallet_client_type: 'privy' },
      ]),
      ...claims,
    }
    const signingInput = `${enc(header)}.${enc(body)}`
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(signingInput)))
    return `${signingInput}.${b64url(sig)}`
  }
  return { pem, mint }
}

describe('Privy identity tokens', () => {
  it("returns the user and their NEAR wallet for a valid token", async () => {
    const { pem, mint } = await privyKeys()
    const key = await importVerificationKey(pem)
    expect(await verifyIdentityToken(await mint(), key, APP, NOW)).toEqual({ userId: 'did:privy:user1', nearAccounts: [ACCOUNT], hasEmail: true })
  })

  it('refuses a token signed by another key', async () => {
    const real = await privyKeys()
    const forger = await privyKeys()
    await expect(verifyIdentityToken(await forger.mint(), await importVerificationKey(real.pem), APP, NOW)).rejects.toThrow('bad token signature')
  })

  it('refuses a tampered payload', async () => {
    const { pem, mint } = await privyKeys()
    const [h, , s] = (await mint()).split('.')
    const other = enc({ iss: 'privy.io', aud: APP, sub: 'did:privy:attacker', exp: NOW + 60, linked_accounts: '[]' })
    await expect(verifyIdentityToken(`${h}.${other}.${s}`, await importVerificationKey(pem), APP, NOW)).rejects.toThrow('bad token signature')
  })

  it('pins ES256: "none" and other algorithms are refused', async () => {
    const { pem, mint } = await privyKeys()
    const key = await importVerificationKey(pem)
    const [, p] = (await mint()).split('.')
    await expect(verifyIdentityToken(`${enc({ alg: 'none' })}.${p}.`, key, APP, NOW)).rejects.toThrow('algorithm')
    await expect(verifyIdentityToken(await mint({}, { alg: 'HS256' }), key, APP, NOW)).rejects.toThrow('algorithm')
  })

  it('checks issuer, audience, expiry and issue time', async () => {
    const { pem, mint } = await privyKeys()
    const key = await importVerificationKey(pem)
    await expect(verifyIdentityToken(await mint({ iss: 'evil.io' }), key, APP, NOW)).rejects.toThrow('issued by Privy')
    await expect(verifyIdentityToken(await mint({ aud: 'other-app' }), key, APP, NOW)).rejects.toThrow('another app')
    await expect(verifyIdentityToken(await mint({ exp: NOW - 31 }), key, APP, NOW)).rejects.toThrow('expired')
    await expect(verifyIdentityToken(await mint({ iat: NOW + 3600 }), key, APP, NOW)).rejects.toThrow('future')
    await expect(verifyIdentityToken(await mint({ sub: '' }), key, APP, NOW)).rejects.toThrow('no user')
    // Within the allowed clock drift.
    expect((await verifyIdentityToken(await mint({ exp: NOW - 29 }), key, APP, NOW)).userId).toBe('did:privy:user1')
  })

  it('only lists NEAR wallets, lowercased', async () => {
    const { pem, mint } = await privyKeys()
    const linked = [
      { type: 'wallet', chain_type: 'ethereum', address: '0xabc' },
      { type: 'wallet', chain_type: 'near', address: 'B'.repeat(64) },
      { type: 'email', address: 'x@example.com', chain_type: 'near' },
    ]
    const id = await verifyIdentityToken(await mint({ linked_accounts: JSON.stringify(linked) }), await importVerificationKey(pem), APP, NOW)
    expect(id.nearAccounts).toEqual(['b'.repeat(64)])
  })

  it('tells an email login from a guest', async () => {
    const { pem, mint } = await privyKeys()
    const key = await importVerificationKey(pem)
    const guest = JSON.stringify([{ type: 'wallet', chain_type: 'near', address: ACCOUNT }])
    expect((await verifyIdentityToken(await mint({ linked_accounts: guest }), key, APP, NOW)).hasEmail).toBe(false)
    const blank = JSON.stringify([{ type: 'email', address: '' }, { type: 'wallet', chain_type: 'near', address: ACCOUNT }])
    expect((await verifyIdentityToken(await mint({ linked_accounts: blank }), key, APP, NOW)).hasEmail).toBe(false)
  })

  it('refuses malformed tokens', async () => {
    const { pem } = await privyKeys()
    const key = await importVerificationKey(pem)
    for (const t of ['', 'a.b', 'a.b.c', `${enc({ alg: 'ES256' })}.not-json.x`]) await expect(verifyIdentityToken(t, key, APP, NOW)).rejects.toThrow()
  })

  it('recognizes implicit accounts', () => {
    expect(isImplicitAccount(ACCOUNT)).toBe(true)
    for (const id of ['A'.repeat(64), 'a'.repeat(63), 'bob.testnet', `${'a'.repeat(63)}g`]) expect(isImplicitAccount(id)).toBe(false)
  })
})
