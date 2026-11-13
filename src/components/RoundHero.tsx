import { phaseOf, progress } from '../state/derive'
import { clock, money } from '../state/format'
import { useLoadedGame } from '../state/GameContext'
import { useUi } from '../state/UiContext'
import { RollingNumber } from './RollingNumber'

export function RoundHero() {
  const { state, account, me, now } = useLoadedGame()
  const { hit } = useUi()
  const r = state.round
  const phase = phaseOf(state, now)
  const isMe = r.king !== null && r.king === me
  const snipeS = Math.round(state.params.snipe_ms / 1000)

  if (phase === 'showdown' || phase === 'settling') {
    const left = phase === 'settling' ? 0 : r.showdown_ends_at! - now
    return (
      <section className="hero hero-sd" aria-labelledby="hero-title">
        <div className="hazard" aria-hidden="true" />
        <h2 id="hero-title" className="sd-title">
          {phase === 'settling' ? 'Crowning' : 'Showdown'}
          <br />
          <b>
            <RollingNumber value={money(r.jackpot)} />
          </b>
        </h2>
        <div className="sd-clock">
          <RollingNumber value={clock(left + (left > 0 ? 999 : 0))} />
        </div>
        <p className="sd-king">{r.king ? (isMe ? 'You are King' : `${r.king} is King`) : 'Nobody is King'}</p>
        <p className="sd-rules">
          {phase === 'settling' ? 'The clock hit zero. The Jackpot is being paid to the King.' : `Last King standing takes the pot. A challenge in the last ${snipeS}s resets the clock to ${clock(state.params.snipe_ms)}.`}
        </p>
        <div className="hazard" aria-hidden="true" />
        <span key={hit.seq} className={`pot-chip ${hit.seq ? 'go' : ''}`} aria-hidden="true">
          {hit.text}
        </span>
      </section>
    )
  }

  const p = progress(state, now)
  return (
    <section className="hero" aria-labelledby="hero-title" data-hit={hit.seq ? hit.seq % 2 : undefined}>
      <div className="burst" aria-hidden="true">
        <span>
          Round
          <br />
          {r.id}
        </span>
      </div>
      <h2 id="hero-title" className="sticker">
        The pot
      </h2>
      <div className="pot">
        <RollingNumber value={money(r.jackpot)} />
        <span key={hit.seq} className={`pot-chip ${hit.seq ? 'go' : ''}`} aria-hidden="true">
          {hit.text}
        </span>
      </div>
      <div className="kingline">
        {r.king ? (
          <>
            <b>{isMe ? 'You are' : r.king}</b> {isMe ? 'King' : 'is King'}
            <br />
            (for now)
          </>
        ) : (
          <>
            No King yet.
            <br />
            <b>Be the first.</b>
          </>
        )}
      </div>
      <p className="kingsub">
        {r.king && r.king_since ? `Held for ${clock(now - r.king_since)}` : `The throne costs ${money(state.params.start_price)} right now.`}
        {isMe && account && (
          <span className="stream">
            {' '}
            · your yield stream <span className="mono">{money(account.king_stream, 4)}</span>
          </span>
        )}
      </p>
      <div className="meter" role="progressbar" aria-label="Progress to the showdown" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
        <i style={{ width: `${p * 100}%` }} />
        <span>
          <em>
            {money(r.jackpot)} / {money(r.showdown_trigger)} → showdown
          </em>
          <em className="meter-r">or {clock(r.backstop_at - now)}</em>
        </span>
      </div>
    </section>
  )
}
