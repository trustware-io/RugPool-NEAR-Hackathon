// Rehearsal M9 and M11: Privy sign-in on testnet. A dev-only page (`privy.html`), kept off the
// app's path:
//   1. email login creates the player's Privy NEAR wallet (an implicit account) and, in the same
//      step, adds the RugPool session key, signed by the Privy wallet right in this page (M11:
//      no second button, no popup). The account must already hold a little NEAR for the gas;
//   2. a challenge is signed with the session key and sent through the relayer.
// The page also serves as the plugin's sign page at `#privy-sign`, for near-connect requests
// that need the player's approval (M9 added the session key that way, from a popup).

import { initSigningPage } from '@peerfolio/privy-near-connect/sign-page'
import { Near, nearConfigFromEnv } from '../near/near'
import { privyFromEnv } from './privySession'

const CHALLENGE_TGAS = 100

const session = privyFromEnv() ?? (() => {
  throw new Error('Set VITE_PRIVY_APP_ID in .env.local.')
})()
const privy = session.privy
const config = nearConfigFromEnv()
const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}

const logBox = el('pre')
function log(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))).join(' ')
  logBox.textContent += `${new Date().toLocaleTimeString()} ${line}\n`
}

async function run(step: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    log(`${step} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e)
  }
}

if (location.hash === '#privy-sign') signPage()
else testPage()

/** The plugin's sign page, opened by its executor as a popup for every wallet request. */
function signPage(): void {
  const approve = el('button', { textContent: 'Approve', disabled: true })
  const reject = el('button', { textContent: 'Reject', onclick: () => window.close() })
  const payload = el('pre', { textContent: 'Waiting for the signing request…' })
  root.append(el('h1', { textContent: 'RugPool: approve with Privy' }), payload, approve, reject, logBox)
  void run('Sign page', async () => {
    // Pinned to testnet: the plugin signs on mainnet whenever a payload names no network.
    const session = await initSigningPage(privy, { allowedOrigins: [location.origin], debug: true, rpcOptions: { url: config.rpcUrls[0]! } })
    payload.textContent = JSON.stringify(session.payload, null, 2)
    approve.disabled = false
    approve.onclick = () => {
      approve.disabled = true
      void run('Signing', session.sign)
    }
  })
}

function testPage(): void {
  const near = new Near(config)
  const email = el('input', { type: 'email', placeholder: 'you@example.com' })
  const code = el('input', { placeholder: '6-digit code' })
  const account = el('strong', { textContent: '(not signed in)' })

  /** Signing in also gets the session key: reused if it's still on the account, else added. */
  async function signIn(): Promise<void> {
    const wallet = await session.wallet()
    account.textContent = wallet.address
    const key = await near.signInWith(wallet.address, await session.signer(wallet), () => session.identityToken())
    log('Signed in as', wallet.address, key === 'added' ? '- session key added, no popup' : '- existing session key reused')
  }

  const sendCode = el('button', { textContent: 'Send code' })
  sendCode.onclick = () => run('Send code', async () => {
    await session.sendCode(email.value.trim())
    log('Code sent to', email.value.trim())
  })
  const verify = el('button', { textContent: 'Verify' })
  verify.onclick = () => run('Sign in', async () => {
    await session.login(email.value.trim(), code.value.trim())
    await signIn()
  })

  const challenge = el('button', { textContent: 'Relayed challenge' })
  challenge.onclick = () => run('Challenge', async () => {
    const state = await near.view<{ round: { next_price: string } }>(config.rugpool, 'get_state')
    const outcome = await near.relayCall(config.rugpool, 'challenge', { max_price: state.round.next_price }, { tgas: CHALLENGE_TGAS })
    if (outcome === null) return log('No usable session key yet: nothing was relayed.')
    const tx = (outcome as { transaction?: { hash?: string; signer_id?: string } }).transaction
    log('Relayed challenge at', state.round.next_price, 'tx', tx?.hash, 'signed by', tx?.signer_id, 'status', (outcome as { status?: unknown }).status)
  })

  root.append(
    el('h1', { textContent: 'RugPool × Privy (testnet rehearsal)' }),
    el('section', {}, el('h2', { textContent: '1. Sign in' }), email, sendCode, el('br'), code, verify, el('p', {}, 'NEAR account: ', account)),
    el('section', {}, el('h2', { textContent: '2. Play' }), challenge),
    logBox,
  )
  void run('Restore', async () => {
    if (!(await privy.user.get().catch(() => null))) return
    log('Restored Privy session.')
    await signIn()
  })
}
