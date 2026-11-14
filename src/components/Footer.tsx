import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { money } from '../state/format'
import { useGame } from '../state/GameContext'
import { contractId, fastMode, mockControls } from '../state/services'
import { Modal } from './modals/Modal'
import { readRulesOptOut, writeRulesOptOut } from '../state/rulesPreference'

export function Footer() {
  const { state } = useGame()
  const controls = mockControls
  const [bots, setBots] = useState(controls?.botsOn() ?? false)
  const [dontShowAgain, setDontShowAgain] = useState(readRulesOptOut)
  const [rulesOpen, setRulesOpen] = useState(() => !dontShowAgain)
  const [preferenceError, setPreferenceError] = useState(false)
  const footer = useRef<HTMLElement>(null)
  const rulesOpener = useRef<HTMLButtonElement>(null)
  const wasRulesOpen = useRef(false)
  useLayoutEffect(() => {
    // Make the existing native dialog modal before the first interactive paint.
    // Shell only mounts Footer once game state is ready; no actions exist while loading.
    const dialog = footer.current?.querySelector<HTMLDialogElement>('dialog')
    if (rulesOpen && dialog && !dialog.open) dialog.showModal()
  }, [rulesOpen])
  useEffect(() => {
    // Conditional dialog removal can precede native focus restoration.
    if (wasRulesOpen.current && !rulesOpen) rulesOpener.current?.focus()
    wasRulesOpen.current = rulesOpen
  }, [rulesOpen])
  const p = state?.params
  const s = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000}s`)

  return (
    <footer ref={footer} className="foot" onKeyDown={(event) => {
      const dialog = rulesOpen ? event.currentTarget.querySelector<HTMLDialogElement>('dialog:modal') : null
      if (dialog && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const step = event.key.startsWith('Page') ? dialog.clientHeight * 0.8 : 40
        if (event.key === 'Home') dialog.scrollTop = 0
        else if (event.key === 'End') dialog.scrollTop = dialog.scrollHeight
        else dialog.scrollTop += ['ArrowUp', 'PageUp'].includes(event.key) ? -step : step
      }
      if (dialog && event.key === 'Tab') {
        const controls = dialog.querySelectorAll<HTMLElement>('button, input')
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
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
                <label className="rules-preference">
                  <input type="checkbox" checked={dontShowAgain} onChange={(event) => {
                    const next = event.currentTarget.checked
                    const saved = writeRulesOptOut(next)
                    setDontShowAgain(saved ? next : readRulesOptOut())
                    setPreferenceError(!saved)
                  }} />
                  <span>Don’t show again <span className="muted small">on this browser</span></span>
                </label>
                {preferenceError && <p role="status">Could not save this preference. Your browser may show these rules again.</p>}
                <p>Take the throne. Be the last King at showdown’s end to win the Jackpot when the round settles.</p>
                <ul>
                  <li><strong>Fund both:</strong> Game balance buys tickets. Keep at least {money(p.min_court)} in the Court to challenge; tickets never spend Court principal.</li>
                  <li><strong>Challenge:</strong> Check the price before confirming. Tickets start at {money(p.start_price)}, rise {p.step_bps / 100}% each challenge and reset each round.</li>
                  <li><strong>Watch the clock:</strong> Late challenges reset the remaining showdown time to {s(p.snipe_ms)}.</li>
                  <li><strong>Auto-defend:</strong> When dethroned, automatically buy back in within your per-ticket max and Game balance, while Court-eligible. Up to 25 retakes per transaction, not a total spending cap.</li>
                  <li><strong>Court rewards:</strong> Fees depend on play; yield needs a funded reserve. Eligible deposits enter the draw without spending principal.</li>
                  <li><strong>Withdraw Court:</strong> Start withdrawal, then wait for the displayed cooldown. Pending funds stop earning and no longer count toward eligibility.</li>
                </ul>
                <p className="muted small">Challenge tickets are spent and non-refundable; paid fees are not Court principal. No guaranteed returns. Contract, token, storage and operator risks apply. Read “Risks and who you trust” below.</p>
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
