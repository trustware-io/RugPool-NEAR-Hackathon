import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DepositTarget } from '../deposit/types'
import { setSound } from './fx'

export type Modal = { kind: 'deposit'; target: DepositTarget } | { kind: 'challenge' } | { kind: 'auto' } | { kind: 'withdraw' } | { kind: 'connect' } | null

export interface Toast {
  id: number
  text: string
  tone?: 'good' | 'bad'
  action?: { label: string; run: () => void }
}

interface UiCtx {
  modal: Modal
  open(m: Exclude<Modal, null>): void
  close(): void
  toasts: Toast[]
  toast(t: Omit<Toast, 'id'>): void
  dismiss(id: number): void
  sound: boolean
  toggleSound(): void
  /** Screen-reader announcement (polite). */
  announce: string
  say(text: string): void
  /** Latest throne change, for the hit flash and the floating pot chip. */
  hit: { seq: number; text: string; rugged: boolean }
  bump(text: string, rugged: boolean): void
}

const Ctx = createContext<UiCtx | null>(null)

export function UiProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<Modal>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [sound, setSoundState] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [hit, setHit] = useState({ seq: 0, text: '', rugged: false })
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++seq.current
      setToasts((list) => [...list.slice(-3), { ...t, id }])
      setTimeout(() => dismiss(id), t.action ? 9_000 : 5_000)
    },
    [dismiss],
  )
  const toggleSound = useCallback(() => {
    const next = !sound
    setSoundState(next)
    void setSound(next)
  }, [sound])

  const bump = useCallback((text: string, rugged: boolean) => setHit((h) => ({ seq: h.seq + 1, text, rugged })), [])

  const value = useMemo<UiCtx>(
    () => ({
      modal,
      open: (m) => setModal(m),
      close: () => setModal(null),
      toasts,
      toast,
      dismiss,
      sound,
      toggleSound,
      announce,
      say: setAnnounce,
      hit,
      bump,
    }),
    [modal, toasts, toast, dismiss, sound, toggleSound, announce, hit, bump],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUi(): UiCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUi outside UiProvider')
  return v
}
