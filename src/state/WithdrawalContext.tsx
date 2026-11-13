import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ContractStore } from '../game/contractStore'
import { useGame } from './GameContext'
import { acquireWithdrawalLock, WithdrawalFlow, type FlowState } from './withdrawalFlow'

interface WithdrawalContextValue {
  supported: boolean; state: FlowState; active: boolean; start(amount?: string, automatic?: boolean): void; stop(): void
}
const Context = createContext<WithdrawalContextValue | null>(null)
export function WithdrawalProvider({ children }: { children: ReactNode }) {
  const { store, refresh, me } = useGame()
  const [error, setError] = useState('')
  const flow = useMemo(() => new WithdrawalFlow({ acquire: acquireWithdrawalLock, marker: {
    getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key),
  } }), [store])
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot)
  useEffect(() => {
    if (store instanceof ContractStore) {
      const key = store.withdrawalKey()
      if (key) flow.inspectRecovery(key)
    }
  }, [flow, store, me])
  useEffect(() => {
    const timer = setInterval(() => { void flow.tick() }, 2000)
    const stop = () => flow.stop()
    window.addEventListener('pagehide', stop)
    return () => { clearInterval(timer); window.removeEventListener('pagehide', stop); flow.stop() }
  }, [flow])
  useEffect(() => {
    if (state.phase === 'complete' || state.phase === 'failed' || state.phase === 'waiting') void refresh().catch(() => { /* freshness is not payout status */ })
  }, [state.phase, refresh])
  const start = (amount?: string, automatic = true) => {
    setError('')
    try {
      if (!(store instanceof ContractStore)) throw Error('Automatic withdrawal is available only for the contract store.')
      if (!me || store.accountId() !== me) throw Error('The displayed account changed. Wait for the account display to refresh before starting.')
      void flow.start(store.captureWithdrawal(automatic), amount, automatic)
    } catch (e) { setError(e instanceof Error ? e.message : 'Existing session unavailable.') }
  }
  const active = ['requesting', 'waiting', 'withdrawing'].includes(state.phase)
  return <Context.Provider value={{ supported: store instanceof ContractStore, state: error ? { phase: 'paused', message: error } : state, active, start, stop: flow.stop }}>{children}</Context.Provider>
}
export function useWithdrawal() {
  const ctx = useContext(Context)
  if (!ctx) throw Error('useWithdrawal outside WithdrawalProvider')
  return ctx
}
