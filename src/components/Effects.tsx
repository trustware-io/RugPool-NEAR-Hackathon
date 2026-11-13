// Turns new contract events into motion, sound, toasts and announcements. It only reads
// events after the first load, so seeded history never fires effects.

import { useEffect, useRef, useState } from 'react'
import { splitTicket } from '../game/curve'
import type { GameEvent } from '../game/types'
import { settleQuip } from '../state/copy'
import { phaseOf } from '../state/derive'
import { buzz, play } from '../state/fx'
import { money } from '../state/format'
import { useGame } from '../state/GameContext'
import { useUi } from '../state/UiContext'
import { JackpotOverlay } from './JackpotOverlay'

type Settled = Extract<GameEvent, { type: 'round_settled' }>

export function Effects() {
  const { onEvents, me, state, now, history } = useGame()
  const { toast, say, bump, hit, modal } = useUi()
  const [settled, setSettled] = useState<{ e: Settled; quip: string } | null>(null)
  const ctx = useRef({ me, state, history, modal })
  ctx.current = { me, state, history, modal }

  useEffect(
    () =>
      onEvents((events) => {
        const { me, state, history, modal } = ctx.current
        // The overlay is a modal dialog: over sign-in (ours, or the wallet connector's popup) it
        // would hide the form and block it until it closes, so a finished round is a toast there.
        const signingIn = modal?.kind === 'connect' || document.querySelector('.hot-connector-popup') !== null
        const split = state?.params.split_bps ?? [5500, 2500, 1500, 500]
        // An auto-defend war lands as ~26 events in one poll: play one cue for the batch.
        const cues = new Set<Parameters<typeof play>[0]>()
        for (const e of events) {
          if (e.type === 'challenged' || e.type === 'auto_defended') {
            const loser = e.type === 'challenged' ? e.data.dethroned : e.data.against
            const [jack, back] = splitTicket(Number(e.data.price), split)
            const rugged = !!me && loser === me
            bump(`+${money(jack)}`, rugged)
            cues.add(rugged ? 'rugged' : 'hit')
            if (rugged) {
              buzz(40)
              toast({ text: `You got rugged by ${e.data.by}. Here is your ${money(back)}.`, tone: 'bad' })
              say(`You were dethroned by ${e.data.by}. ${money(back)} credited.`)
            } else if (me && e.type === 'auto_defended' && e.data.by === me) {
              toast({ text: `Auto-defend retook the throne for you at ${money(e.data.price)}.`, tone: 'good' })
            }
          } else if (e.type === 'showdown_started') {
            cues.add('alarm')
            buzz(60)
            say('Showdown started. Last King standing takes the Jackpot.')
          } else if (e.type === 'round_settled') {
            cues.add('jackpot')
            const who = e.data.winner === me ? 'You' : e.data.winner
            if (signingIn) toast({ text: who ? `${who} won the Jackpot: ${money(e.data.jackpot)}.` : 'The round ended with no King. The Jackpot rolls over.' })
            else setSettled({ e, quip: settleQuip([...history, ...events], e, me) })
            say(e.data.winner ? `${e.data.winner === me ? 'You' : e.data.winner} won the Jackpot: ${money(e.data.jackpot)}.` : 'The round ended with no King. The Jackpot rolls over.')
          } else if (e.type === 'draw_won' && me && e.data.by === me) {
            cues.add('coin')
            toast({ text: `You won the no-loss draw: ${money(e.data.amount)}.`, tone: 'good' })
          }
        }
        const cue = (['rugged', 'alarm', 'jackpot', 'coin', 'hit'] as const).find((c) => cues.has(c))
        if (cue) play(cue)
      }),
    [onEvents, bump, toast, say],
  )

  // Announce the showdown clock at a few milestones, not every second.
  const lastMark = useRef<number | null>(null)
  useEffect(() => {
    if (!state || phaseOf(state, now) !== 'showdown') {
      lastMark.current = null
      return
    }
    const left = Math.ceil((state.round.showdown_ends_at! - now) / 1000)
    const mark = [60, 30, 10].find((m) => left <= m && left > m - 2)
    if (mark && lastMark.current !== mark) {
      lastMark.current = mark
      say(`${mark} seconds left in the showdown.`)
    }
  }, [state, now, say])

  return (
    <>
      {hit.seq > 0 && <div key={hit.seq} className={`flash ${hit.rugged ? 'is-rugged' : ''}`} aria-hidden="true" />}
      {settled && <JackpotOverlay event={settled.e} quip={settled.quip} me={me} nextRound={state?.round.id ?? 0} startPrice={state?.params.start_price ?? '0'} onClose={() => setSettled(null)} />}
    </>
  )
}
