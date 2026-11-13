import { useEffect, useRef, useState } from 'react'
import { money } from '../state/format'
import { useGame } from '../state/GameContext'
import { contractId, fastMode, mockControls } from '../state/services'
import { Modal } from './modals/Modal'

export function Footer() {
  const { state } = useGame()
  const controls = mockControls
  const [bots, setBots] = useState(controls?.botsOn() ?? false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const rulesOpener = useRef<HTMLButtonElement>(null)
  const wasRulesOpen = useRef(false)
  useEffect(() => {
    // Conditional dialog removal can precede native focus restoration.
    if (wasRulesOpen.current && !rulesOpen) rulesOpener.current?.focus()
    wasRulesOpen.current = rulesOpen
  }, [rulesOpen])
  const p = state?.params
  const s = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000}s`)

  return (
    <footer className="foot" onKeyDown={(event) => {
      const dialog = rulesOpen ? event.currentTarget.querySelector<HTMLDialogElement>('dialog:modal') : null
      if (dialog && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const step = event.key.startsWith('Page') ? dialog.clientHeight * 0.8 : 40
        if (event.key === 'Home') dialog.scrollTop = 0
        else if (event.key === 'End') dialog.scrollTop = dialog.scrollHeight
        else dialog.scrollTop += ['ArrowUp', 'PageUp'].includes(event.key) ? -step : step
      }
      if (rulesOpen && event.key === 'Tab') {
        // Rules are read-only; Close is the only focusable dialog control.
        const close = event.currentTarget.querySelector<HTMLButtonElement>('dialog:modal .x')
        if (close) {
          event.preventDefault()
          close.focus()
        }
      }
    }}>
      <p className="powered">Deposits powered by Trustware</p>
      <p className="muted small">{contractId ? `Contract: ${contractId} (NEAR testnet rehearsal) · Direct tUSDC deposits` : 'Contract: rugpool.testnet (mock) · Settled on NEAR via NEAR Intents'}</p>
      {state && p && (
        <>
          <button ref={rulesOpener} type="button" className="btn-line rules-opener" aria-haspopup="dialog" onClick={(event) => {
            // Establish the opener for pointer and keyboard interactions.
            event.currentTarget.focus()
            setRulesOpen(true)
          }}>
            Rules & instructions
          </button>
          {rulesOpen && (
            <Modal title="Rules & instructions" onClose={() => setRulesOpen(false)}>
              <div className="rules-content">
                <p>Sign in, deposit funds, then join the Court before challenging. Review the current price before confirming a challenge. The last King standing wins the Jackpot when the round settles.</p>
                <p className="muted small">{contractId ? 'Values below come from the connected game state.' : 'Mock mode: values below describe this local simulation, not a deployed game.'}</p>
                <ul>
                  <li>The first challenge costs {money(p.start_price)}. Each challenge adds {p.step_bps / 100}%. The price resets every round.</li>
                  <li>Every ticket splits {p.split_bps.map((b) => b / 100).join(' / ')}: Jackpot, the King you dethrone, the Court, the protocol.</li>
                  <li>
                    No early end. The current round's showdown threshold is {money(state.round.showdown_trigger)}; its age limit is {s(state.round.backstop_at - state.round.started_at)}. The showdown runs {s(p.showdown_ms)}; a challenge with less than {s(p.snipe_ms)} remaining extends the remaining time to {s(p.snipe_ms)}.
                  </li>
                  <li>Auto-defend retakes the throne for you in the same transaction, up to your max price, with at most 25 retakes per transaction.</li>
                  <li>
                    You need {money(p.min_court)} in the Court to challenge. Request a Court withdrawal, then wait until its displayed ready time before withdrawing. Eligible Court deposits enter the draw without spending Court principal. Yield depends on the funded reserve; fees depend on play. Funds remain exposed to contract, token, storage and operator risks.
                  </li>
                  <li>Challenge tickets are spent, not refundable Court deposits. Nothing promises a return. Read “Risks and who you trust” below before playing.</li>
                </ul>
              </div>
            </Modal>
          )}
        </>
      )}
      {p && (
        <details className="rules">
          <summary>Risks and who you trust</summary>
          <ul>
            <li>Tickets are spent. You can lose them. Nothing here promises a return.</li>
            {contractId && (
              <li>
                {contractId === 'pool.rugpool-release-20261112.testnet'
                  ? 'pool.rugpool-release-20261112.testnet was verified on November 12, 2026 to match this release’s current contract build on NEAR testnet. This is a deployment snapshot, not a guarantee against later code changes.'
                  : 'This target has not been verified against this release’s current contract build. Historical or other unverified targets may differ: do not assume they have the payout records, owner recovery or storage protections described below.'}
              </li>
            )}
            <li>
              This is a hackathon build{contractId ? ' on NEAR testnet, played with test USDC' : ''}. The contract is unaudited, and whoever holds its account key can replace its code.
            </li>
            <li>
              The owner can pause new play: challenges, Court joins and deposits. The pause doesn't disable claims or withdrawals, though a storage shortage or a failed payout can still stop one from completing. A showdown already running still ends on time. The owner also collects the protocol's share of each ticket and can take back the yield reserve.
            </li>
            <li>
              The draw's winner is picked by a drand round named in advance. If drand never publishes that round, the draw pot stays locked: the contract has no owner method to release it without that round's signature. Only Court deposits of $5 or more enter the draw, and it holds 500 entrants.
            </li>
            <li>Yield is paid from a reserve the operator funds. When the reserve is empty, yield stops. The Court's share of tickets still pays out.</li>
            <li>
              Payouts started by this version are recorded until their outcome is booked. If that step fails, the amount stays on the contract's books and the owner can settle it by hand after an hour, using the chain's record of whether the transfer went through. The contract can't check the owner's answer. Payouts started by an older build have no such record.
            </li>
            <li>
              If the contract runs short of NEAR for storage, new deposits, Court joins, arming auto-defend and freezing a new draw stop until it is topped up, and the live feed may miss events. Challenges, claims and withdrawals aren't paused, but they still need enough NEAR for what they store: if the remaining storage is used up, they can fail until the contract is topped up. The buffer doesn't guarantee that exits are available.
            </li>
            <li>
              With an email login, Privy manages your NEAR account's key and RugPool's relayer sends your actions and pays the gas. While the relayer is down you can't challenge or ask to withdraw. A claim, or a withdrawal whose cooldown has ended, can go through any relayer.
            </li>
          </ul>
        </details>
      )}
      {controls && (
        <div className="mock-bar">
          <span>Mock mode{fastMode ? ' · demo timings' : ''}</span>
          <button
            type="button"
            aria-pressed={bots}
            onClick={() => {
              controls.setBots(!bots)
              setBots(!bots)
            }}
          >
            Bots: {bots ? 'on' : 'off'}
          </button>
          <a href={fastMode ? '?' : '?fast=1'}>{fastMode ? 'Spec timings' : 'Demo timings'}</a>
        </div>
      )}
    </footer>
  )
}
