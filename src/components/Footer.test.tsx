import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SPEC_PARAMS } from '../game/params'
import { Footer } from './Footer'

vi.mock('../state/services', () => ({ contractId: null, fastMode: false, mockControls: null }))
vi.mock('../state/GameContext', () => ({ useGame: () => ({ state: {
  params: {
    start_price: SPEC_PARAMS.startPrice, step_bps: SPEC_PARAMS.stepBps,
    split_bps: SPEC_PARAMS.splitBps, min_court: SPEC_PARAMS.minCourt,
    showdown_ms: SPEC_PARAMS.showdownMs, snipe_ms: SPEC_PARAMS.snipeMs,
  },
  round: { showdown_trigger: 100_000_000n, started_at: 0, backstop_at: 60_000 },
} }) }))
afterEach(() => vi.unstubAllGlobals())

describe('Rules entry and initial render', () => {
  it('renders the existing rules dialog automatically with an unchecked opt-out', () => {
    const html = renderToStaticMarkup(<Footer />)
    expect(html).toContain('<dialog')
    expect(html).toContain('Don’t show again')
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('Challenge tickets are spent')
    const dialog = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'))
    expect(dialog.match(/<li>/g)).toHaveLength(6)
    expect(dialog).toContain('Take the throne.')
    expect(dialog).toContain('Game balance buys tickets')
    expect(dialog).toContain('$25.00')
    expect(dialog).toContain('$5.00')
    expect(dialog).toContain('3%')
    expect(dialog).toContain('1 min')
    expect(dialog).toContain('per-ticket max')
    expect(dialog).toContain('25 retakes per transaction, not a total spending cap')
    expect(dialog).toContain('displayed cooldown')
    expect(dialog).toContain('non-refundable')
    expect(dialog).not.toContain('Mock mode:')
    expect(dialog).toContain('aria-labelledby="m-title"')
    expect(html).toContain('Contract: rugpool.testnet (mock)')
    expect(html).toContain('The contract is unaudited')
    expect(html).toContain('Only Court deposits of $5 or more enter the draw')
  })
  it('suppresses automatic rules for opted-out visitors but keeps the manual entry', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'true' })
    const html = renderToStaticMarkup(<Footer />)
    expect(html).not.toContain('<dialog')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('Rules &amp; instructions')
  })
})
