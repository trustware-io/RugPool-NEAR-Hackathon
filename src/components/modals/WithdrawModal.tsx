import { useState } from 'react'
import { money } from '../../state/format'
import { useLoadedGame } from '../../state/GameContext'
import { withdrawCooldownLabel } from '../../state/services'
import { useUi } from '../../state/UiContext'
import { useAction } from '../../state/useAction'
import { useWithdrawal } from '../../state/WithdrawalContext'
import { WithdrawalStatus } from '../WithdrawalStatus'
import { Modal } from './Modal'

export function WithdrawModal() {
  const { state, account, store, me } = useLoadedGame()
  const { close } = useUi()
  const { run, busy } = useAction()
  const withdrawal = useWithdrawal()
  const court = BigInt(account?.court ?? '0')
  const [usd, setUsd] = useState(() => `${court / 1_000_000n}.${String(court % 1_000_000n).padStart(6, '0')}`)
  const [whole, fraction = ''] = usd.split('.')
  const amount = /^\d+(\.\d{0,6})?$/.test(usd) ? BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')) : 0n
  const left = court - amount
  const request = async () => {
    if (withdrawal.supported) { withdrawal.start(String(amount)); return }
    const err = await run(() => store.requestWithdraw(String(amount)), `Withdrawal requested.`)
    if (!err) close()
  }
  return (
    <Modal title="Withdraw from the Court" sub={`It leaves the Court now, so it stops earning and stops counting toward your odds. The contract controls the ${withdrawCooldownLabel} cooldown.`} onClose={close}>
      <label className="field">
        <span>Amount (USDC), up to {money(String(court))}</span>
        <input type="number" inputMode="decimal" min="0" step="0.000001" disabled={withdrawal.active} value={usd} onChange={(e) => setUsd(e.target.value)} />
      </label>
      {left < BigInt(state.params.min_court) && <p className="warn-line">Dropping below {money(state.params.min_court)} in the Court removes your ability to challenge.</p>}
      {withdrawal.supported && <>
        <p>Request {usd || '0'} USDC from Court, then automatically finish <strong>all pending Court withdrawals</strong> to <strong>{me}</strong> after the cooldown while this page stays open.</p>
        {BigInt(account?.withdraw_pending ?? '0') > 0n && <p>Already pending: {money(account!.withdraw_pending)}. A new request restarts the cooldown for all pending funds.</p>}
        <p className="muted small">The final payout is not capped at this selected amount. Changes we observe stop automatic completion; other authorized activity after our check can change the full pending payout. An existing relay session is required; we never automatically renew it or open a wallet.</p>
      </>}
      <WithdrawalStatus />
      {withdrawal.supported && <details>
        <summary>External wallet without a relay session?</summary>
        <p>Use your wallet explicitly for each transaction. This requests only {usd || '0'} USDC from Court; it does not arm automatic completion. After the cooldown, use the panel’s wallet finish action.</p>
        <button type="button" className="btn-line" disabled={withdrawal.active || withdrawal.state.phase === 'unknown' || amount <= 0n || amount > court} onClick={() => withdrawal.start(String(amount), false)}>Request only — approve in external wallet</button>
      </details>}
      <div className="actions" aria-busy={withdrawal.active || busy}>
        <button type="button" className="btn-line" onClick={close}>{withdrawal.active ? 'Close — continue while page stays open' : 'Close'}</button>
        <button type="button" className="btn-solid" disabled={busy || withdrawal.active || withdrawal.state.phase === 'unknown' || amount <= 0n || amount > court} onClick={() => void request()}>
          {withdrawal.supported ? 'Start Court withdrawal' : 'Request withdrawal'}
        </button>
      </div>
    </Modal>
  )
}
