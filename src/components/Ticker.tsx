import { tickerText } from '../state/copy'
import { useGame } from '../state/GameContext'

export function Ticker() {
  const { history, me } = useGame()
  const items = history.slice(-10).reverse().map((e) => tickerText(e, me))
  if (!items.length) return null
  const line = items.join(' ★ ') + ' ★ '
  return (
    <div className="tape" aria-hidden="true">
      {/* Two copies, animated by -50%, make the loop seamless. */}
      <span>
        {line}
        {line}
      </span>
    </div>
  )
}
