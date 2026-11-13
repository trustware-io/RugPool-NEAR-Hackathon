import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountView, GameEvent, GameState, GameStore } from '../game/types'
import { useUi } from './UiContext'

const HISTORY_MAX = 300

interface GameCtx {
  store: GameStore
  state: GameState | null
  account: AccountView | null
  me: string | null
  /** Every event this page has seen, oldest first. */
  history: GameEvent[]
  now: number
  connect(): Promise<void>
  refresh(): Promise<void>
  /** Called with events newer than the first load. History from the first load never fires. */
  onEvents(fn: (events: GameEvent[]) => void): () => void
}

const Ctx = createContext<GameCtx | null>(null)

export function GameProvider({ store, children }: { store: GameStore; children: ReactNode }) {
  const [state, setState] = useState<GameState | null>(null)
  const [account, setAccount] = useState<AccountView | null>(null)
  const [me, setMe] = useState<string | null>(store.accountId())
  const [history, setHistory] = useState<GameEvent[]>([])
  const [now, setNow] = useState(() => store.now())
  const cursor = useRef<number | null>(null)
  const listeners = useRef(new Set<(e: GameEvent[]) => void>())

  const inflight = useRef<Promise<void>>(Promise.resolve())

  // Polls and post-action refreshes run one at a time, so each sees the latest cursor
  // and no event is appended twice.
  const refresh = useCallback(() => {
    const run = inflight.current.then(async () => {
      const id = store.accountId()
      const [s, a, page] = await Promise.all([store.getState(), id ? store.getAccount(id) : Promise.resolve(null), store.getEvents(cursor.current ?? 0)])
      const first = cursor.current === null
      const fresh = page.events.filter((e) => e.id > (cursor.current ?? 0))
      cursor.current = page.cursor
      setState(s)
      setAccount(a)
      setMe(id)
      if (fresh.length) {
        setHistory((h) => [...h, ...fresh].slice(-HISTORY_MAX))
        if (!first) listeners.current.forEach((fn) => fn(fresh))
      }
    })
    inflight.current = run.catch(() => {})
    return run
  }, [store])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const loop = async () => {
      try {
        await refresh()
      } finally {
        if (live) timer = setTimeout(loop, store.pollMs)
      }
    }
    void loop()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [refresh, store])

  useEffect(() => {
    const t = setInterval(() => setNow(store.now()), 250)
    return () => clearInterval(t)
  }, [store])

  const { open } = useUi()
  // With email sign-in on offer, Connect opens the sign-in choice; otherwise the wallet picker.
  const connect = useCallback(async () => {
    if (store.emailSignIn) return open({ kind: 'connect' })
    await store.connect()
    await refresh()
  }, [store, refresh, open])

  const onEvents = useCallback((fn: (e: GameEvent[]) => void) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  const value = useMemo(() => ({ store, state, account, me, history, now, connect, refresh, onEvents }), [store, state, account, me, history, now, connect, refresh, onEvents])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useGame(): GameCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useGame outside GameProvider')
  return v
}

/** For components that render only after the first state load. */
export function useLoadedGame(): GameCtx & { state: GameState } {
  const g = useGame()
  if (!g.state) throw new Error('state not loaded')
  return g as GameCtx & { state: GameState }
}
