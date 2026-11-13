import { useCallback, useState } from 'react'
import { GameError } from '../game/types'
import { useGame } from './GameContext'
import { useUi } from './UiContext'

/** Runs a store action, refreshes views, and turns failures into a visible toast. Never silent. */
export function useAction() {
  const { refresh } = useGame()
  const { toast } = useUi()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (fn: () => Promise<void>, ok?: string): Promise<GameError | null> => {
      setBusy(true)
      try {
        await fn()
        if (ok) toast({ text: ok, tone: 'good' })
        return null
      } catch (e) {
        const err = e instanceof GameError ? e : new GameError('INVALID_AMOUNT', e instanceof Error ? e.message : 'Something went wrong.')
        toast({ text: err.message, tone: 'bad' })
        return err
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [refresh, toast],
  )

  return { run, busy }
}
