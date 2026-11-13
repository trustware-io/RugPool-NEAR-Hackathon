import { useDeposit } from '../state/DepositContext'
import { clock, money } from '../state/format'
import { useGame } from '../state/GameContext'
import { contractId } from '../state/services'
import { useUi } from '../state/UiContext'

function DepositPill() {
  const { active } = useDeposit()
  useGame() // re-render on the shared clock tick
  const { open } = useUi()
  if (!active) return null
  let text: string
  let pct = 0
  switch (active.phase) {
    case 'awaiting_signature':
      text = 'Confirm in your wallet'
      break
    case 'settling': {
      // Local clock is fine here: the ETA comes from the deposit service, not the contract.
      const left = active.startedAt + active.etaMs - Date.now()
      pct = Math.min(1, 1 - left / active.etaMs)
      text = `Settling ${money(active.receive)} · ${left > 0 ? clock(left + 999) : 'any second'}`
      break
    }
    case 'credited':
      text = `Credited ${money(active.receive)}`
      pct = 1
      break
    case 'failed':
      text = 'Deposit failed'
      break
  }
  return (
    <button type="button" className={`dep-pill is-${active.phase}`} onClick={() => open({ kind: 'deposit', target: active.target })}>
      <span className="dep-bar" style={{ width: `${pct * 100}%` }} aria-hidden="true" />
      <span className="dep-text">{text}</span>
    </button>
  )
}

export function Header() {
  const { me, account, connect } = useGame()
  const { open, sound, toggleSound } = useUi()
  return (
    <header className="top">
      <div className="brand">
        <span className="logo">
          Rug<em>Pool</em>
        </span>
        <span className="net">NEAR testnet · {contractId ? 'rehearsal contract' : 'mock'}</span>
      </div>
      <div className="top-r">
        <DepositPill />
        {me && account && (
          <>
            <span className="chip">
              <small>Game</small> {money(account.balance)}
            </span>
            <span className="chip chip-court">
              <small>Court</small> {money(account.court)}
            </span>
          </>
        )}
        <button type="button" className="icon-btn" aria-pressed={sound} onClick={toggleSound} title={sound ? 'Sound on' : 'Sound off'}>
          <span aria-hidden="true">{sound ? '🔊' : '🔇'}</span>
          <span className="sr">Sound</span>
        </button>
        {me ? (
          <button type="button" className="btn-ink" onClick={() => open({ kind: 'deposit', target: 'court' })}>
            Deposit
          </button>
        ) : (
          <button type="button" className="btn-ink" onClick={() => void connect()}>
            Connect
          </button>
        )}
        {me && <span className="acct">{me}</span>}
      </div>
    </header>
  )
}
