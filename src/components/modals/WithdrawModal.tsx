import { useState } from 'react'
import { money, usdToMicro } from '../../state/format'
import { useLoadedGame } from '../../state/GameContext'
import { contractId, withdrawCooldownLabel } from '../../state/services'
import { useUi } from '../../state/UiContext'
import { useAction } from '../../state/useAction'
import { Modal } from './Modal'

export function WithdrawModal() {
  const { state, account, store } = useLoadedGame()
  const { close } = useUi()
  const { run, busy } = useAction()
  const court = Number(account?.court ?? 0)
  const [usd, setUsd] = useState(() => (court / 1_000_000).toFixed(2))
  const amount = Math.min(court, usdToMicro(Number(usd) || 0))
  const left = court - amount
  const min = Number(state.params.min_court)

  const request = async () => {
    const err = await run(() => store.requestWithdraw(String(amount)), `Withdrawal of ${money(amount)} requested.`)
    if (!err) close()
  }

  return (
    <Modal title="Withdraw from the Court" sub={`It leaves the Court now, so it stops earning and stops counting toward your odds. After a ${withdrawCooldownLabel} cooldown you withdraw it to your ${contractId ? 'wallet' : 'game balance'}.`} onClose={close}>
      <label className="field">
        <span>Amount (USD), up to {money(court)}</span>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={usd} onChange={(e) => setUsd(e.target.value)} />
      </label>
      {left < min && <p className="warn-line">Dropping below {money(min)} in the Court removes your ability to challenge.</p>}
      <div className="actions">
        <button type="button" className="btn-line" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn-solid" disabled={busy || amount <= 0} onClick={() => void request()}>
          Request withdrawal
        </button>
      </div>
    </Modal>
  )
}
