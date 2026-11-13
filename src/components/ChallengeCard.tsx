import { buzz } from '../state/fx'
import { nextPrice, phaseOf, playerOf, rugBack } from '../state/derive'
import { money } from '../state/format'
import { useLoadedGame } from '../state/GameContext'
import { useUi } from '../state/UiContext'

/** Fixed to the bottom on phones (one thumb), inline on desktop. */
export function ChallengeCard() {
  const { state, account, me, now, connect } = useLoadedGame()
  const { open } = useUi()
  const phase = phaseOf(state, now)
  const player = playerOf(state, account, me)
  const price = money(nextPrice(state))
  const [j, k, c, p] = state.params.split_bps.map((b) => b / 100)

  let label: string
  let amount: string | null = price
  let disabled = false
  let onClick = () => {
    buzz()
    open({ kind: 'challenge' })
  }
  if (player.kind === 'disconnected') {
    label = 'Connect to play'
    amount = null
    onClick = () => void connect()
  } else if (state.paused) {
    label = 'Paused. Claims and withdrawals still work'
    amount = null
    disabled = true
  } else if (phase === 'settling') {
    label = 'Crowning the King'
    amount = null
    disabled = true
  } else if (player.kind === 'king') {
    label = "You're the King"
    amount = null
    disabled = true
  } else if (player.kind === 'needs_court') {
    label = Number(account?.court ?? 0) > 0 ? `Add ${money(player.missing)} to the Court to play` : `Deposit ${money(state.params.min_court)} to the Court to play`
    amount = null
    onClick = () => open({ kind: 'deposit', target: 'court' })
  } else {
    label = phase === 'showdown' ? 'Snipe it' : state.round.king ? 'Rug the King' : 'Take the throne'
  }

  return (
    <section className="cta" aria-label="Challenge">
      <button type="button" className={`btn-rug ${amount ? '' : 'is-text'}`} disabled={disabled} onClick={onClick}>
        <span>{label}</span>
        {amount && <span>{amount}</span>}
      </button>
      <p className="warn">
        <b>Tickets are spent. You can lose this.</b>
        <span className="cta-back"> Get rugged next and you get {money(rugBack(state))} back.</span>
      </p>
      <div className="splitbar" aria-hidden="true">
        <i style={{ width: `${j}%` }} />
        <i style={{ width: `${k}%` }} />
        <i style={{ width: `${c}%` }} />
        <i style={{ width: `${p}%` }} />
      </div>
      <p className="splitline">
        {j}% Jackpot · {k}% the King you rug · {c}% Court · {p}% protocol
      </p>
    </section>
  )
}
