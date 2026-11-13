// Binds a verified Privy login to a NEAR account. The browser sends the player's Privy identity
// token: a JWT that Privy signs with ES256 for this app, listing the user's linked accounts. The
// relayer checks it with the app's public verification key (Privy dashboard, "Verify with key
// instead"), so only a real email login whose Privy NEAR wallet is that exact account gets funded.
// WebCrypto does the ES256 check; no JWT library is needed.

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

/**
 * Verifies a Privy identity token and returns who it names, or throws. Checks the signature
 * (ES256 only), the issuer, the audience (this app), and the expiry, allowing `skewSec` of clock
 * drift.
 */
export async function verifyIdentityToken(token: string, key: CryptoKey, appId: string, nowSec: number, skewSec = 30): Promise<PrivyIdentity> {
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
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url(s), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('bad token signature')
  if (typeof payload !== 'object' || payload === null) throw new Error('malformed token')
  const c = payload as Record<string, unknown>
  if (c.iss !== 'privy.io') throw new Error('token not issued by Privy')
  if (c.aud !== appId) throw new Error('token is for another app')
  if (typeof c.exp !== 'number' || c.exp + skewSec < nowSec) throw new Error('token expired')
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
