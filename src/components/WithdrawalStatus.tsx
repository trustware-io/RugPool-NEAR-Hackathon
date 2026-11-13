import { useWithdrawal } from '../state/WithdrawalContext'
import '../styles/withdrawal.css'
export function WithdrawalStatus() {
  const { state, active, stop } = useWithdrawal()
  if (state.phase === 'idle') return null
  return <div className="withdrawal-progress">
    <div role="status" aria-live="polite" aria-atomic="true">
      {active && <span className="withdrawal-ring" aria-hidden="true" />}
      <span>{state.message}</span>
    </div>
    {state.id && <p className="small">Transaction: {state.id}</p>}
    {state.requestId && <p className="small">Court request transaction: {state.requestId}</p>}
    {state.scope && <p className="muted small">Withdrawal scope: {state.scope}</p>}
    {active && <button type="button" className="btn-line" onClick={stop}>Stop automatic completion</button>}
  </div>
}
