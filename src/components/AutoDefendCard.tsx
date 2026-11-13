import { autoDefendCover } from '../state/derive'
import { money } from '../state/format'
import { useLoadedGame } from '../state/GameContext'
import { useUi } from '../state/UiContext'

export function AutoDefendCard() {
  const { state, account, me, connect } = useLoadedGame()
  const { open } = useUi()
  const max = Number(account?.auto_defend_max ?? 0)
  const armed = max > 0
  const cover = armed && account ? autoDefendCover(state, max, Number(account.balance)) : null

  return (
    <section className="panel auto" aria-labelledby="auto-title">
      <div className="panel-head">
        <h2 id="auto-title" className="lbl">
          Auto-defend
        </h2>
        <span className={`badge ${armed ? 'is-armed' : ''}`}>{armed ? '🛡 Armed' : 'Off'}</span>
      </div>
      <p className="muted">If someone rugs you, the contract retakes the throne for you in the same transaction, up to your max price. Up to 25 retakes per transaction.</p>
      <dl className="rows">
        <div>
          <dt>Max retake price</dt>
          <dd>{armed ? money(max) : 'not set'}</dd>
        </div>
        <div>
          <dt>Retakes left at current prices</dt>
          <dd>{cover ? cover.retakes : 0}</dd>
        </div>
        <div>
          <dt>Most it could spend</dt>
          <dd>{cover ? money(cover.spend) : '$0.00'}</dd>
        </div>
      </dl>
      {me ? (
        <button type="button" className="btn-line" onClick={() => open({ kind: 'auto' })}>
          {armed ? 'Change auto-defend' : 'Arm auto-defend'}
        </button>
      ) : (
        <button type="button" className="btn-line" onClick={() => void connect()}>
          Connect to arm
        </button>
      )}
    </section>
  )
}
