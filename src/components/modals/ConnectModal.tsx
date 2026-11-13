import { useState } from 'react'
import type { EmailSignIn } from '../../game/types'
import { useGame } from '../../state/GameContext'
import { useUi } from '../../state/UiContext'
import { useAction } from '../../state/useAction'
import { Modal } from './Modal'

/** Email sign-in first (a one-time code, then a NEAR account with the session key), NEAR wallets second. */
export function ConnectModal({ email: signIn }: { email: EmailSignIn }) {
  const { store, refresh } = useGame()
  const { close } = useUi()
  const { run, busy } = useAction()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  const send = async () => {
    const address = email.trim()
    const err = await run(() => signIn.sendCode(address), `Code sent to ${address}.`)
    if (!err) setSentTo(address)
  }

  const verify = async () => {
    if (!sentTo) return
    const err = await run(async () => {
      await signIn.verify(sentTo, code.trim())
    }, 'Signed in. Play with no popups.')
    if (!err) close()
  }

  const wallet = async () => {
    close()
    await store.connect()
    await refresh()
  }

  return (
    <Modal title="Sign in to play" sub="Use your email: we create your NEAR account, and every play after that needs no popup and no gas." onClose={close}>
      {sentTo ? (
        <label className="field">
          <span>The 6-digit code we sent to {sentTo}</span>
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
        </label>
      ) : (
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
      )}
      <div className="actions">
        <button type="button" className="btn-line" disabled={busy} onClick={() => void wallet()}>
          Use a NEAR wallet
        </button>
        {sentTo ? (
          <button type="button" className="btn-solid" disabled={busy || code.trim().length < 6} onClick={() => void verify()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        ) : (
          <button type="button" className="btn-solid" disabled={busy || !email.includes('@')} onClick={() => void send()}>
            Send code
          </button>
        )}
      </div>
    </Modal>
  )
}
