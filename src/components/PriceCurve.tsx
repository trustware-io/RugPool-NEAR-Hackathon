import { pricesThisRound } from '../game/curve'
import { money } from '../state/format'
import { useLoadedGame } from '../state/GameContext'
import { RollingNumber } from './RollingNumber'

const W = 600
const H = 150

export function PriceCurve() {
  const { state } = useLoadedGame()
  const r = state.round
  const paid = pricesThisRound(r.challenges, Number(state.params.start_price), state.params.step_bps)
  const next = Number(r.next_price)
  const bars = [...paid, next]
  const slots = Math.max(bars.length, 14)
  const max = Math.max(...bars) * 1.08
  const min = Number(state.params.start_price) * 0.7
  const bw = W / slots
  const y = (v: number) => H - ((v - min) / (max - min)) * H

  return (
    <section className="price" aria-labelledby="price-title">
      <div className="price-head">
        <div>
          <h2 id="price-title" className="lbl">
            Next ticket
          </h2>
          <div className="price-big">
            <RollingNumber value={money(next)} />
            <span className="up" aria-hidden="true">
              ▲
            </span>
          </div>
          <p className="muted">
            {money(state.params.start_price)} start · +{state.params.step_bps / 100}% every challenge · {r.challenges} so far
          </p>
        </div>
      </div>
      <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Prices this round: ${r.challenges} challenges, from ${money(state.params.start_price)} up to a next price of ${money(next)}.`}>
        {bars.map((v, i) => (
          <rect key={i} x={i * bw + bw * 0.12} y={y(v)} width={bw * 0.76} height={H - y(v)} className={i === bars.length - 1 ? 'bar-next' : 'bar'} />
        ))}
      </svg>
    </section>
  )
}
