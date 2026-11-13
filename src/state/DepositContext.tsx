// Deposit progress lives above the modal, so the player can close the modal while
// USDC settles and still see progress in the header.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DepositService, DepositTarget, Quote } from '../deposit/types'
import { money } from './format'
import { useGame } from './GameContext'
import { useUi } from './UiContext'

export type ActiveDeposit =
  | { phase: 'awaiting_signature'; target: DepositTarget; receive: number }
  | { phase: 'settling'; target: DepositTarget; receive: number; startedAt: number; etaMs: number }
  | { phase: 'credited'; target: DepositTarget; receive: number }
  | { phase: 'failed'; target: DepositTarget; receive: number; reason: string }

interface DepositCtx {
  service: DepositService
  active: ActiveDeposit | null
  run(quote: Quote): Promise<void>
  clear(): void
}

const Ctx = createContext<DepositCtx | null>(null)

export function DepositProvider({ service, children }: { service: DepositService; children: ReactNode }) {
  const { refresh } = useGame()
  const { toast, open } = useUi()
  const [active, setActive] = useState<ActiveDeposit | null>(null)
  const unsub = useRef<(() => void) | null>(null)

  const clear = useCallback(() => setActive(null), [])

  const run = useCallback(
    async (quote: Quote) => {
      const { target } = quote.request
      const receive = quote.receive
      setActive({ phase: 'awaiting_signature', target, receive })
      let id: string
      try {
        id = await service.submitDeposit(quote)
      } catch (e) {
        setActive({ phase: 'failed', target, receive, reason: e instanceof Error ? e.message : 'The wallet did not sign.' })
        return
      }
      unsub.current?.()
      unsub.current = service.trackStatus(id, (s) => {
        if (s.phase === 'settling') setActive({ phase: 'settling', target, receive, startedAt: s.startedAt, etaMs: s.etaMs })
        else if (s.phase === 'failed') {
          setActive({ phase: 'failed', target, receive, reason: s.reason })
          toast({ text: `Deposit failed: ${s.reason}`, tone: 'bad' })
          void refresh()
        } else if (s.phase === 'credited') {
          setActive({ phase: 'credited', target, receive })
          void refresh()
          toast({
            text: target === 'court' ? `Credited ${money(s.amount)} to the Court.` : `Credited ${money(s.amount)} to your game balance.`,
            tone: 'good',
            action: target === 'court' ? { label: 'Challenge now', run: () => open({ kind: 'challenge' }) } : { label: 'Join the Court', run: () => open({ kind: 'deposit', target: 'court' }) },
          })
          setTimeout(() => setActive((a) => (a?.phase === 'credited' ? null : a)), 2_500)
        }
      })
    },
    [service, refresh, toast, open],
  )

  const value = useMemo(() => ({ service, active, run, clear }), [service, active, run, clear])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDeposit(): DepositCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDeposit outside DepositProvider')
  return v
}
