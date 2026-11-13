import { useEffect, useState } from 'react'
import type { DepositTarget, Quote, SourceAsset } from '../../deposit/types'
import { registrationFeeDue } from '../../game/fee'
import { useDeposit } from '../../state/DepositContext'
import { money, usdToMicro } from '../../state/format'
import { useLoadedGame } from '../../state/GameContext'
import { useUi } from '../../state/UiContext'
import { contractId } from '../../state/services'
import { useAction } from '../../state/useAction'
import { Modal } from './Modal'

const GAME_BALANCE = 'near:balance'

function Progress() {
  const { active, clear } = useDeposit()
  const { close, open } = useUi()
  if (!active) return null
  const steps = ['Confirm in your wallet', contractId ? 'Executing on NEAR testnet' : 'Settling to NEAR via NEAR Intents', 'Credited on NEAR']
  const at = active.phase === 'awaiting_signature' ? 0 : active.phase === 'settling' ? 1 : 2
  return (
    <div className="dep-progress">
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s} className={active.phase === 'failed' && i === at ? 'is-bad' : i < at || active.phase === 'credited' ? 'is-done' : i === at ? 'is-on' : ''}>
            {s}
          </li>
        ))}
      </ol>
      {active.phase === 'settling' && <p className="muted small">You can close this. Progress stays in the header.</p>}
      {active.phase === 'failed' && (
        <p className="err" role="alert">
          {active.reason}
        </p>
      )}
      <div className="actions">
        {active.phase === 'failed' ? (
          <button type="button" className="btn-solid" onClick={clear}>
            Try again
          </button>
        ) : active.phase === 'credited' ? (
          <button type="button" className="btn-solid" onClick={() => (active.target === 'court' ? open({ kind: 'challenge' }) : open({ kind: 'deposit', target: 'court' }))}>
            {active.target === 'court' ? 'Challenge now' : 'Join the Court'}
          </button>
        ) : (
          <button type="button" className="btn-line" onClick={close}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}

export function DepositModal({ target: initialTarget }: { target: DepositTarget }) {
  const { state, account, me, store, connect } = useLoadedGame()
  const { close } = useUi()
  const { service, active, run: runDeposit } = useDeposit()
  const { run, busy } = useAction()
  const [assets, setAssets] = useState<SourceAsset[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [target, setTarget] = useState<DepositTarget>(initialTarget)
  const [source, setSource] = useState<string>('base:usdc')
  const [usd, setUsd] = useState('30')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const balance = Number(account?.balance ?? 0)
  const court = Number(account?.court ?? 0)
  const min = Number(state.params.min_court)
  const amount = Number(usd) || 0
  const fromBalance = source === GAME_BALANCE && target === 'court'

  useEffect(() => {
    if (!me) return
    let live = true
    service
      .getBalances(me)
      .then((a) => {
        if (!live) return
        setAssets(a)
        // Keep the pick if it still exists; otherwise default to the first asset found.
        setSource((s) => (s === GAME_BALANCE || a.some((x) => x.id === s) ? s : (a[0]?.id ?? s)))
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : 'Could not load balances.'))
    return () => {
      live = false
    }
  }, [service, me, active?.phase])

  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    setQuoting(false)
    if (!me || fromBalance || amount <= 0) return
    let live = true
    setQuoting(true)
    const t = setTimeout(() => {
      service
        .getQuote({ account: me, assetId: source, amountUsd: amount, target })
        .then((q) => live && setQuote(q))
        .catch((e: unknown) => live && setQuoteError(e instanceof Error ? e.message : 'Could not get a quote.'))
        .finally(() => live && setQuoting(false))
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [service, me, source, amount, target, fromBalance])

  if (!me) {
    return (
      <Modal title="Deposit from any chain" onClose={close}>
        <p className="sub">Connect a NEAR wallet first. Deposits land in your RugPool account on NEAR.</p>
        <div className="actions">
          <button type="button" className="btn-solid" onClick={() => void connect()}>
            Connect
          </button>
        </div>
      </Modal>
    )
  }

  const fee = fromBalance ? 0 : registrationFeeDue(state, account, me)
  const afterCourt = court + (fromBalance ? usdToMicro(amount) : Math.max(0, (quote?.receive ?? 0) - fee))
  const asset = assets?.find((a) => a.id === source)

  return (
    <Modal title="Deposit from any chain" sub={contractId ? 'Rehearsal: test USDC straight from your NEAR wallet.' : 'Trustware finds your balances. NEAR Intents settles USDC on NEAR.'} onClose={close}>
      {active ? (
        <Progress />
      ) : (
        <>
          <fieldset className="field">
            <legend>Send to</legend>
            <div className="seg">
              <label className={target === 'court' ? 'is-on' : ''}>
                <input type="radio" name="target" checked={target === 'court'} onChange={() => setTarget('court')} /> The Court
                <small>earns fees + yield, unlocks challenges</small>
              </label>
              <label className={target === 'balance' ? 'is-on' : ''}>
                <input
                  type="radio"
                  name="target"
                  checked={target === 'balance'}
                  onChange={() => {
                    setTarget('balance')
                    if (source === GAME_BALANCE) setSource(assets?.[0]?.id ?? 'base:usdc')
                  }}
                />{' '}
                Game balance
                <small>pays for tickets</small>
              </label>
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>Pay with</legend>
            {!assets && !loadError && <p className="muted">{contractId ? 'Reading your tUSDC balance…' : 'Finding your balances with Trustware…'}</p>}
            {loadError && <p className="err">{loadError}</p>}
            <div className="assets">
              {target === 'court' && balance > 0 && (
                <label className={`asset ${source === GAME_BALANCE ? 'is-on' : ''}`}>
                  <input type="radio" name="src" checked={source === GAME_BALANCE} onChange={() => setSource(GAME_BALANCE)} />
                  <span>
                    <b>Game balance</b> on NEAR
                  </span>
                  <span className="mono">{money(balance)}</span>
                </label>
              )}
              {assets?.map((a) => (
                <label key={a.id} className={`asset ${source === a.id ? 'is-on' : ''}`}>
                  <input type="radio" name="src" checked={source === a.id} onChange={() => setSource(a.id)} />
                  <span>
                    <b>{a.symbol}</b> on {a.chain}
                  </span>
                  <span className="mono">{money(usdToMicro(a.usd))}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span>Amount (USD)</span>
            <input type="number" inputMode="decimal" min="1" step="1" value={usd} onChange={(e) => setUsd(e.target.value)} />
          </label>

          {!fromBalance && (
            <div className="quote" aria-live="polite">
              {quoting && (
                <p className="muted">
                  Quoting {money(usdToMicro(amount))} of {asset?.symbol ?? 'USDC'} on {asset?.chain ?? 'Base'}…
                </p>
              )}
              {quoteError && <p className="err">{quoteError}</p>}
              {quote && !quoting && (
                <dl>
                  <div>
                    <dt>You send</dt>
                    <dd>
                      {money(quote.sendAmount)} {quote.sendSymbol} on {quote.sendChain}
                    </dd>
                  </div>
                  <div>
                    <dt>Route fee (quote)</dt>
                    <dd>${quote.feeUsd.toFixed(2)}</dd>
                  </div>
                  <div>
                    <dt>You receive</dt>
                    <dd>{money(quote.receive)} USDC on NEAR</dd>
                  </div>
                  {fee > 0 && (
                    <div>
                      <dt>One-time account fee</dt>
                      <dd>{money(fee)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Estimated time</dt>
                    <dd>~{Math.round(quote.etaMs / 1000)}s</dd>
                  </div>
                </dl>
              )}
            </div>
          )}

          {target === 'court' && (fromBalance || quote) && afterCourt < min && <p className="warn-line">You will have {money(afterCourt)} in the Court. Challenges unlock at {money(min)}.</p>}

          <div className="actions">
            <button type="button" className="btn-line" onClick={close}>
              Cancel
            </button>
            {fromBalance ? (
              <button
                type="button"
                className="btn-solid"
                disabled={busy || amount <= 0 || usdToMicro(amount) > balance}
                onClick={() => void run(() => store.joinCourt(String(usdToMicro(amount))), `Joined the Court with ${money(usdToMicro(amount))}.`).then((err) => !err && close())}
              >
                Join from balance
              </button>
            ) : (
              <button type="button" className="btn-solid" disabled={!quote || quoting} onClick={() => quote && void runDeposit(quote)}>
                Confirm deposit
              </button>
            )}
          </div>
        </>
      )}
      {!contractId && <p className="powered">Deposits powered by Trustware</p>}
    </Modal>
  )
}
