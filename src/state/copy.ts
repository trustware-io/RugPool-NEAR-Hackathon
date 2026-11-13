// Feed and flavor copy. Satire about crypto excess; numbers and risk lines stay plain.

import type { GameEvent } from '../game/types'
import { money } from './format'

export type FeedTag = 'rug' | 'auto' | 'showdown' | 'paid' | 'court' | 'draw'

export interface FeedLine {
  id: number
  at: number
  tag: FeedTag
  label: string
  text: string
}

const who = (id: string | null, me: string | null) => (id && id === me ? 'you' : (id ?? 'nobody'))

export function feedLine(e: GameEvent, me: string | null, kingBps: number): FeedLine {
  const base = { id: e.id, at: e.at }
  switch (e.type) {
    case 'challenged': {
      const { by, price, dethroned } = e.data
      const back = money(Math.floor((Number(price) * kingBps) / 10_000))
      return dethroned
        ? { ...base, tag: 'rug', label: 'Rug', text: `${who(by, me)} rugged ${who(dethroned, me)} for ${money(price)}. ${dethroned === me ? 'You get' : `${dethroned} gets`} ${back} back.` }
        : { ...base, tag: 'rug', label: 'Throne', text: `${who(by, me)} took the empty throne for ${money(price)}. Long live the King (for now).` }
    }
    case 'auto_defended':
      return { ...base, tag: 'auto', label: 'Auto', text: `Auto-defend: ${who(e.data.by, me)} retook the throne from ${who(e.data.against, me)} at ${money(e.data.price)}.` }
    case 'showdown_started':
      return {
        ...base,
        tag: 'showdown',
        label: 'Showdown',
        text: e.data.reason === 'size' ? 'Showdown! The Jackpot hit the trigger. Last King standing takes it.' : 'Showdown! The round hit its age limit. Last King standing takes it.',
      }
    case 'round_settled':
      return e.data.winner
        ? { ...base, tag: 'paid', label: 'Paid', text: `${who(e.data.winner, me)} won the Jackpot: ${money(e.data.jackpot)} (${e.data.multiple.toFixed(1)}x the last ticket).` }
        : { ...base, tag: 'paid', label: 'Rollover', text: 'Nobody held the throne. The Jackpot rolls over.' }
    case 'court_join':
      return { ...base, tag: 'court', label: 'Court', text: `${who(e.data.by, me)} joined the Court with ${money(e.data.amount)}. The Court thanks you for your donation.` }
    case 'withdraw':
      return { ...base, tag: 'court', label: 'Out', text: `${who(e.data.by, me)} left the Court with ${money(e.data.amount)}.` }
    case 'draw_won':
      return { ...base, tag: 'draw', label: 'Draw', text: `No-loss draw: ${who(e.data.by, me)} won ${money(e.data.amount)} without buying a ticket.` }
  }
}

/** Short form for the ticker tape. */
export function tickerText(e: GameEvent, me: string | null): string {
  switch (e.type) {
    case 'challenged':
      return e.data.dethroned ? `${who(e.data.by, me)} rugged ${who(e.data.dethroned, me)} ${money(e.data.price)}` : `${who(e.data.by, me)} took the throne ${money(e.data.price)}`
    case 'auto_defended':
      return `${who(e.data.by, me)} auto-defended ${money(e.data.price)}`
    case 'showdown_started':
      return 'showdown is live'
    case 'round_settled':
      return e.data.winner ? `${who(e.data.winner, me)} took the pot ${money(e.data.jackpot)}` : 'the pot rolls over'
    case 'court_join':
      return `${who(e.data.by, me)} joined the court ${money(e.data.amount)}`
    case 'withdraw':
      return `${who(e.data.by, me)} left the court`
    case 'draw_won':
      return `${who(e.data.by, me)} won the no-loss draw ${money(e.data.amount)}`
  }
}

/**
 * The jackpot-screen quip: name the King the winner dethroned last and how long that
 * King lasted, from the events this page has seen.
 */
export function settleQuip(history: GameEvent[], settled: Extract<GameEvent, { type: 'round_settled' }>, me: string | null): string {
  const winner = settled.data.winner
  if (!winner) return 'Nobody wanted the throne. The price is back to $5.'
  const takes = history.filter((e): e is Extract<GameEvent, { type: 'challenged' | 'auto_defended' }> => (e.type === 'challenged' || e.type === 'auto_defended') && e.id < settled.id)
  const winning = [...takes].reverse().find((e) => e.data.by === winner)
  const loser = winning ? (winning.type === 'challenged' ? winning.data.dethroned : winning.data.against) : null
  if (winning && loser) {
    const crowned = [...takes].reverse().find((e) => e.id < winning.id && e.data.by === loser)
    const secs = crowned ? Math.max(1, Math.round((winning.at - crowned.at) / 1000)) : null
    const name = loser === me ? 'You' : loser
    return secs ? `${name}, you were King for ${secs} seconds. Here is your 25%.` : `${name}, you have been rugged. Here is your 25%.`
  }
  return winner === me ? 'Long live the King (for now). The Court thanks you for the fees.' : `Long live ${winner} (for now).`
}
