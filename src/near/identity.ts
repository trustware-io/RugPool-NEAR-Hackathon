// Binds a verified Privy login to a NEAR account. The browser sends the player's Privy identity
// token: a JWT that Privy signs with ES256 for this app, listing the user's linked accounts. The
// relayer checks it with the configured app's public JWKS or an explicitly selected fixed PEM.
// WebCrypto verifies ES256; activation.ts still enforces email and exact NEAR account binding.

export interface PrivyIdentity {
  /** The user's Privy DID: one per email login. */
  userId: string
  /** The NEAR wallet addresses Privy linked to the user (64-hex implicit accounts). */
  nearAccounts: string[]
  /** Whether the login has an email linked. A Privy guest account has none. */
  hasEmail: boolean
}

const b64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const b64url = (s: string) => b64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

/** Imports the verification key as Privy shows it: a PEM "PUBLIC KEY" (SPKI, P-256). */
export function importVerificationKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '')
  return crypto.subtle.importKey('spki', b64(body), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

type VerificationKey = CryptoKey | ((header: Record<string, unknown>) => Promise<CryptoKey>)

export type IdentityVerificationConfig = { mode: 'jwks' } | { mode: 'pem'; pem: string }

/** Explicit mode selection: never falls back from a failed JWKS request to a fixed key. */
export async function createIdentityVerifier(
  appId: string,
  config: IdentityVerificationConfig,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<(token: string) => Promise<PrivyIdentity>> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('invalid Privy app ID')
  const now = deps.now ?? Date.now
  let key: VerificationKey
  if (config.mode === 'pem') {
    if (!config.pem) throw new Error('missing Privy verification PEM')
    key = await importVerificationKey(config.pem)
  } else if (config.mode === 'jwks') {
    key = remoteVerificationKey(appId, deps.fetch ?? globalThis.fetch, now)
  } else {
    throw new Error('invalid Privy verification mode')
  }
  return (token) => verifyIdentityToken(token, key, appId, Math.floor(now() / 1000))
}

/** One bounded cache per verifier/app, not per attacker-supplied kid. */
function remoteVerificationKey(appId: string, fetcher: typeof fetch, now: () => number): VerificationKey {
  const url = `https://api.privy.io/v1/apps/${appId}/jwks.json`
  let keys = new Map<string, CryptoKey>()
  let expiresAt = 0
  let retryAt = 0
  let pending: Promise<void> | undefined
  async function reload() {
    // Invalidate first: refresh errors must not revive an expired/previous keyset.
    keys = new Map()
    expiresAt = 0
    retryAt = now() + 30_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetcher(url, { signal: controller.signal, redirect: 'error', credentials: 'omit' })
      if (response.status !== 200 || !response.body) throw new Error('Privy JWKS unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 65_536) throw new Error('Privy JWKS too large')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const body = json(bytes) as { keys?: unknown } | null
      if (!body || !Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32) throw new Error('invalid Privy JWKS keys')
      const next = new Map<string, CryptoKey>()
      for (const item of body.keys) {
        const k = item as (JsonWebKey & { kid?: unknown }) | null
        if (!k || typeof k.kid !== 'string' || !k.kid || k.kid.length > 256 || next.has(k.kid)
          || k.kty !== 'EC' || k.crv !== 'P-256' || k.alg !== 'ES256' || k.use !== 'sig' || k.d !== undefined
          || (k.key_ops !== undefined && (!Array.isArray(k.key_ops) || k.key_ops.length !== 1 || k.key_ops[0] !== 'verify'))) {
          throw new Error('invalid Privy JWKS key')
        }
        next.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']))
      }
      keys = next
      expiresAt = now() + 600_000
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  return async (header) => {
    const kid = header.kid
    if (typeof kid !== 'string' || !kid || kid.length > 256) throw new Error('missing or invalid token kid')
    if (pending) await pending
    if (now() >= expiresAt || !keys.has(kid)) {
      if (now() < retryAt) throw new Error('Privy signing key unavailable')
      pending = reload()
      try { await pending } finally { pending = undefined }
    }
    const key = keys.get(kid)
    if (!key || now() >= expiresAt) throw new Error('unmatched Privy signing key')
    return key
  }
}

/**
 * Verifies a Privy identity token and returns who it names, or throws. Checks the signature
 * (ES256 only), the issuer, the audience (this app), and the expiry, allowing `skewSec` of clock
 * drift.
 */
export async function verifyIdentityToken(token: string, key: VerificationKey, appId: string, nowSec: number, skewSec = 30): Promise<PrivyIdentity> {
  if (token.length > 65_536) throw new Error('token too large')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [h, p, s] = parts as [string, string, string]
  let header: unknown
  let payload: unknown
  try {
    header = json(b64url(h))
    payload = json(b64url(p))
  } catch {
    throw new Error('malformed token')
  }
  // Pinning the algorithm stops "alg": "none" and key-confusion tricks.
  if (typeof header !== 'object' || header === null || (header as { alg?: unknown }).alg !== 'ES256') throw new Error('unexpected token algorithm')
  const resolvedKey = typeof key === 'function' ? await key(header as Record<string, unknown>) : key
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, resolvedKey, b64url(s), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('bad token signature')
  if (typeof payload !== 'object' || payload === null) throw new Error('malformed token')
  const c = payload as Record<string, unknown>
  if (c.iss !== 'privy.io') throw new Error('token not issued by Privy')
  if (c.aud !== appId) throw new Error('token is for another app')
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || c.exp + skewSec <= nowSec) throw new Error('token expired')
  if (typeof c.iat === 'number' && c.iat - skewSec > nowSec) throw new Error('token issued in the future')
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('token names no user')
  let linked: unknown
  try {
    linked = typeof c.linked_accounts === 'string' ? JSON.parse(c.linked_accounts) : []
  } catch {
    throw new Error('malformed linked accounts')
  }
  const accounts = (Array.isArray(linked) ? linked : []).filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
  const nearAccounts = accounts
    .filter((a) => a.type === 'wallet' && a.chain_type === 'near' && typeof a.address === 'string')
    .map((a) => (a.address as string).toLowerCase())
  const hasEmail = accounts.some((a) => a.type === 'email' && typeof a.address === 'string' && a.address !== '')
  return { userId: c.sub, nearAccounts, hasEmail }
}

/** A NEAR implicit account: 64 lowercase hex characters (an ed25519 public key). */
export const isImplicitAccount = (id: string) => /^[0-9a-f]{64}$/.test(id)
