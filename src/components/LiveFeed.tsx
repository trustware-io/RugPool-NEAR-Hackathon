import { feedLine } from '../state/copy'
import { ago } from '../state/format'
import { useGame } from '../state/GameContext'

export function LiveFeed() {
  const { history, me, now, state } = useGame()
  const kingBps = state?.params.split_bps[1] ?? 2500
  const lines = history.slice(-20).reverse().map((e) => feedLine(e, me, kingBps))
  return (
    <section className="panel feed" aria-labelledby="feed-title">
      <h2 id="feed-title" className="lbl">
        Live feed
      </h2>
      <ol aria-live="polite" aria-relevant="additions">
        {lines.length === 0 && <li className="muted">Quiet in the throne room.</li>}
        {lines.map((l) => (
          <li key={l.id} className={`tag-${l.tag}`}>
            <span className="tag">{l.label}</span>
            <span className="msg">{l.text}</span>
            <span className="when">{ago(now - l.at)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
