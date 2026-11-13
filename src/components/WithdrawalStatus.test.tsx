import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WithdrawalStatus } from './WithdrawalStatus'
vi.mock('../state/WithdrawalContext', () => ({ useWithdrawal: () => ({ state: { phase: 'waiting', message: 'Cooldown — finish all pending to alice while this page stays open.' }, active: true, stop: () => {} }) }))
describe('withdrawal progress', () => {
  it('retains accessible text, decorative ring and explicit stop', () => {
    const html = renderToStaticMarkup(<WithdrawalStatus />)
    expect(html).toContain('role="status"'); expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('Stop automatic completion'); expect(html).toContain('all pending')
    expect(html).not.toContain('%')
  })
})
