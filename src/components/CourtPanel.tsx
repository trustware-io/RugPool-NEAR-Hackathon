import { clock, money, pct } from '../state/format'
import { useLoadedGame } from '../state/GameContext'
import { useUi } from '../state/UiContext'
import { contractId } from '../state/services'
import { useAction } from '../state/useAction'
import { useWithdrawal } from '../state/WithdrawalContext'
import { WithdrawalStatus } from './WithdrawalStatus'

export function CourtPanel() {
  const { state, account, me, now, store, connect } = useLoadedGame()
  const { open } = useUi()
  const { run, busy } = useAction()
  const withdrawal = useWithdrawal()
  const c = state.court
  const earned = account ? Number(account.court_earned) + Number(account.king_stream) : 0
  // The contract's claim also pays out the game balance (the build plan's dethroned-King credits).
  const claimable = earned + (contractId && account ? Number(account.balance) : 0)
  const ready = account?.withdraw_ready_at ?? null
  const pending = account ? Number(account.withdraw_pending) : 0

  return (
    <section className="panel court" aria-labelledby="court-title">
      <div className="panel-head">
        <h2 id="court-title" className="lbl">
          The Court
        </h2>
        <span className="muted small">the house</span>
      </div>
      <div className="apy">
        <b>{pct(c.apy_bps_live)} APY</b>
        <span>variable, from game activity</span>
      </div>
      <dl className="rows">
        <div>
          <dt>Your deposit</dt>
          <dd>{account ? money(account.court) : '-'}</dd>
        </div>
        {pending > 0 && (
          <div>
            <dt>On its way out</dt>
            <dd>{money(pending)}</dd>
          </div>
        )}
        <div>
          <dt>Earned (fees + yield)</dt>
          <dd className="good">{account ? money(earned) : '-'}</dd>
        </div>
        <div>
          <dt>Court size</dt>
          <dd>{money(c.total, 0)}</dd>
        </div>
        <div>
          <dt>Draw pot · your odds</dt>
          <dd>
            {money(c.draw_pot)} · {account ? pct(account.draw_weight_bps, 2) : '0.00%'}
          </dd>
        </div>
        {c.pending_draw ? (
          <div>
            <dt>Drawing {money(c.pending_draw.pot)}</dt>
            <dd>drand round {c.pending_draw.round}</dd>
          </div>
        ) : (
          <div>
            <dt>Next no-loss draw</dt>
            <dd>{clock(c.next_draw_at - now)}</dd>
          </div>
        )}
      </dl>
      {me ? (
        <div className="btn-row">
          <button type="button" className="btn-solid" disabled={state.paused} onClick={() => open({ kind: 'deposit', target: 'court' })}>
            Deposit to Court
          </button>
          <button type="button" className="btn-line" disabled={busy || claimable < 1} onClick={() => void run(() => store.claim(), contractId ? `Sent ${money(claimable)} to your wallet.` : `Claimed ${money(earned)} to your game balance.`)}>
            Claim
          </button>
          {withdrawal.supported ? (
            <>
              {pending > 0 && <button type="button" className="btn-line" disabled={withdrawal.active || withdrawal.state.phase === 'unknown'} onClick={() => withdrawal.start()}>
                Finish all pending Court withdrawals
              </button>}
              <button type="button" className="btn-line" disabled={withdrawal.active || withdrawal.state.phase === 'unknown' || !account || BigInt(account.court) <= 0n} onClick={() => open({ kind: 'withdraw' })}>Withdraw from Court</button>
            </>
          ) : ready !== null && now >= ready ? (
            <button type="button" className="btn-line" disabled={busy} onClick={() => void run(() => store.withdraw(), contractId ? 'Withdrawn to your wallet.' : 'Withdrawn to your game balance.')}>
              Withdraw now
            </button>
          ) : (
            <button type="button" className="btn-line" disabled={!account || Number(account.court) <= 0 || ready !== null} onClick={() => open({ kind: 'withdraw' })}>
              {ready !== null ? `Withdraw in ${clock(ready - now)}` : 'Withdraw'}
            </button>
          )}
        </div>
      ) : (
        <button type="button" className="btn-solid" onClick={() => void connect()}>
          Connect to join the Court
        </button>
      )}
      {withdrawal.supported && pending > 0 && <p className="small">Pending: {money(account!.withdraw_pending)} to {me}. {ready !== null && now < ready ? `Cooldown display: ${clock(ready - now)}. ` : ''}Finish authorizes all pending funds after chain-confirmed readiness while this page stays open; it does not request more from Court.</p>}
      <WithdrawalStatus />
      {withdrawal.supported && pending > 0 && <details>
        <summary>External wallet continuation</summary>
        <p>Finish all pending funds to {me} with an explicit wallet approval. This does not arm automatic completion or request more from Court.</p>
        <button type="button" className="btn-line" disabled={withdrawal.active || withdrawal.state.phase === 'unknown'} onClick={() => withdrawal.start(undefined, false)}>Finish all pending — approve in external wallet</button>
      </details>}
      <p className="muted small">You need {money(state.params.min_court)} in the Court to challenge and $5 to enter the weekly draw. Your Court deposit is refundable: request a withdrawal and it unlocks after a cooldown.</p>
    </section>
  )
}
