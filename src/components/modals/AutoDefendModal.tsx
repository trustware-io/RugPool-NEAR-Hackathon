import { useState } from 'react'
import { autoDefendCover, nextPrice } from '../../state/derive'
import { money, usdToMicro } from '../../state/format'
import { useLoadedGame } from '../../state/GameContext'
import { useUi } from '../../state/UiContext'
import { useAction } from '../../state/useAction'
import { Modal } from './Modal'

export function AutoDefendModal() {
  const { state, account, store } = useLoadedGame()
  const { close } = useUi()
  const { run, busy } = useAction()
  const current = Number(account?.auto_defend_max ?? 0)
  const minUsd = Math.ceil(nextPrice(state) / 1_000_000)
  const maxUsd = Math.max(100, minUsd * 4)
  const [usd, setUsd] = useState(() => (current > 0 ? Math.round(current / 1_000_000) : Math.min(maxUsd, minUsd * 3)))
  const cover = autoDefendCover(state, usdToMicro(usd), Number(account?.balance ?? 0))

  const arm = async () => {
    const err = await run(() => store.setAutoDefend(String(usdToMicro(usd))), `Auto-defend armed up to ${money(usdToMicro(usd))}.`)
    if (!err) close()
  }
  const disarm = async () => {
    const err = await run(() => store.setAutoDefend('0'), 'Auto-defend disarmed.')
    if (!err) close()
  }

  return (
    <Modal title="Auto-defend" sub="When someone rugs you, the contract retakes the throne for you at the next curve price, until the price passes your max. Up to 25 retakes per transaction." onClose={close}>
      <label className="field">
        <span>
          Max retake price: <b className="mono">{money(usdToMicro(usd))}</b>
        </span>
        <input type="range" min={minUsd} max={maxUsd} step={1} value={usd} onChange={(e) => setUsd(Number(e.target.value))} />
      </label>
      <dl className="quote">
        <div>
          <dt>Retakes covered by your balance</dt>
          <dd>{cover.retakes}</dd>
        </div>
        <div>
          <dt>Most it could spend</dt>
          <dd>{money(cover.spend)}</dd>
        </div>
        <div>
          <dt>Your game balance</dt>
          <dd>{money(account?.balance ?? 0)}</dd>
        </div>
      </dl>
      <p className="warn-line">Every retake is a spent ticket.</p>
      {cover.retakes === 0 && <p className="err">Your balance does not cover a single retake at this max. Top up or raise the max.</p>}
      <div className="actions">
        {current > 0 && (
          <button type="button" className="btn-line" disabled={busy} onClick={() => void disarm()}>
            Disarm
          </button>
        )}
        <button type="button" className="btn-line" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn-solid" disabled={busy} onClick={() => void arm()}>
          {current > 0 ? 'Update auto-defend' : 'Arm auto-defend'}
        </button>
      </div>
    </Modal>
  )
}
