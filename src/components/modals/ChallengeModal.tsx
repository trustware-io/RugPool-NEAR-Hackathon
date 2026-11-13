import { useState } from 'react'
import { splitTicket } from '../../game/curve'
import { GameError } from '../../game/types'
import { guardPrice, nextPrice, phaseOf, playerOf } from '../../state/derive'
import { buzz, play } from '../../state/fx'
import { money, usdToMicro } from '../../state/format'
import { useLoadedGame } from '../../state/GameContext'
import { useUi } from '../../state/UiContext'
import { Modal } from './Modal'

export function ChallengeModal() {
  const { state, account, me, now, store, refresh } = useLoadedGame()
  const { close, open, toast } = useUi()
  const [guard, setGuard] = useState(() => (guardPrice(state) / 1_000_000).toFixed(2))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const price = nextPrice(state)
  const [jack, king, court, protocol] = splitTicket(price, state.params.split_bps)
  const player = playerOf(state, account, me)
  const phase = phaseOf(state, now)
  const balance = Number(account?.balance ?? 0)
  const short = balance < price

  const go = async (retry: boolean) => {
    // A retry re-arms the guard one step above the live price; the first try uses the input.
    const max = retry ? guardPrice(state) : usdToMicro(Number(guard))
    if (retry) setGuard((max / 1_000_000).toFixed(2))
    setBusy(true)
    setError(null)
    try {
      await store.challenge(String(max))
      buzz(20)
      play('hit')
      toast({ text: `You took the throne for ${money(price)}. Long live the King (for now).`, tone: 'good' })
      close()
    } catch (e) {
      if (e instanceof GameError && e.code === 'PRICE_MOVED' && e.price) {
        setError(`Price moved to ${money(e.price)}, above your max. Nothing was spent; your funds stay in your balance.`)
      } else {
        setError(e instanceof Error ? e.message : 'The challenge failed.')
      }
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  let blocker: string | null = null
  if (player.kind === 'disconnected') blocker = 'Connect a wallet to play.'
  else if (player.kind === 'king') blocker = "You're already the King. Sit tight."
  else if (player.kind === 'needs_court') blocker = `Add ${money(player.missing)} to the Court to challenge.`
  else if (phase === 'settling') blocker = 'The showdown is over. The King is being crowned.'

  return (
    <Modal title={state.round.king ? `Rug ${state.round.king}` : 'Take the empty throne'} sub={`Pay ${money(price)} from your game balance (${money(balance)}).`} onClose={close}>
      <dl className="quote">
        <div>
          <dt>Jackpot gets</dt>
          <dd>{money(jack)}</dd>
        </div>
        <div>
          <dt>{state.round.king ? `${state.round.king} gets (25%)` : 'Jackpot (no King yet)'}</dt>
          <dd>{money(king)}</dd>
        </div>
        <div>
          <dt>Court gets</dt>
          <dd>{money(court)}</dd>
        </div>
        <div>
          <dt>Protocol gets</dt>
          <dd>{money(protocol)}</dd>
        </div>
      </dl>
      <label className="field">
        <span>Max price: cancel if the price moves above this (USD)</span>
        <input type="number" inputMode="decimal" min="0" step="0.01" value={guard} onChange={(e) => setGuard(e.target.value)} />
      </label>
      <p className="warn-line">Tickets are spent. You can lose this.</p>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {blocker ? (
        <p className="err" role="alert">
          {blocker}
        </p>
      ) : short ? (
        <p className="err" role="alert">
          Your game balance is {money(balance)}. Top up to buy this ticket.
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="btn-line" onClick={close}>
          Cancel
        </button>
        {player.kind === 'needs_court' || (short && !blocker) ? (
          <button type="button" className="btn-solid" onClick={() => open({ kind: 'deposit', target: player.kind === 'needs_court' ? 'court' : 'balance' })}>
            {player.kind === 'needs_court' ? 'Deposit to the Court' : 'Top up balance'}
          </button>
        ) : (
          <button type="button" className="btn-solid" disabled={busy || !!blocker} onClick={() => void go(!!error)}>
            {busy ? 'Confirm in your wallet' : error ? `Retry at ${money(price)}` : `Challenge for ${money(price)}`}
          </button>
        )}
      </div>
    </Modal>
  )
}
