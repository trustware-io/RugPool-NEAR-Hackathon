import { useState } from 'react'
import type { GameEvent } from '../game/types'
import { money } from '../state/format'
import { useGame } from '../state/GameContext'

type Tab = 'pots' | 'rugs' | 'draws'
const TABS: [Tab, string][] = [
  ['pots', 'Biggest pots'],
  ['rugs', 'Most challenges'],
  ['draws', 'Draw winners'],
]

function rows(history: GameEvent[], tab: Tab): [string, string][] {
  if (tab === 'pots') {
    return history
      .flatMap((e) => (e.type === 'round_settled' && e.data.winner ? [[e.data.winner, Number(e.data.jackpot), e.data.multiple] as const] : []))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w, j, m]) => [w, `${money(j)} · ${m.toFixed(1)}x`])
  }
  if (tab === 'rugs') {
    const n = new Map<string, number>()
    for (const e of history) if (e.type === 'challenged' || e.type === 'auto_defended') n.set(e.data.by, (n.get(e.data.by) ?? 0) + 1)
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w, c]) => [w, `${c}`])
  }
  return history
    .flatMap((e) => (e.type === 'draw_won' ? [[e.data.by, money(e.data.amount)] as [string, string]] : []))
    .reverse()
    .slice(0, 5)
}

export function Leaderboard() {
  const { history, me } = useGame()
  const [tab, setTab] = useState<Tab>('pots')
  const list = rows(history, tab)
  return (
    <section className="panel board" aria-labelledby="board-title">
      <h2 id="board-title" className="lbl">
        Hall of Kings
      </h2>
      <div className="tabs" role="tablist" aria-label="Leaderboard">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls="board-panel" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <ol id="board-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {list.length === 0 && <li className="muted">Nothing yet. Make history.</li>}
        {list.map(([name, v], i) => (
          <li key={name + i}>
            <span className="rank">{i + 1}</span>
            <span className="name">{name === me ? 'you' : name}</span>
            <span className="v">{v}</span>
          </li>
        ))}
      </ol>
      <p className="muted small">From the events this page has seen.</p>
    </section>
  )
}
