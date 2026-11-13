import { useEffect, useRef } from 'react'
import type { GameEvent } from '../game/types'
import { reducedMotion } from '../state/fx'
import { money } from '../state/format'
import { RollingNumber } from './RollingNumber'

type Settled = Extract<GameEvent, { type: 'round_settled' }>

const AUTO_CLOSE_MS = 7_000

function confetti(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  canvas.width = innerWidth
  canvas.height = innerHeight
  const cols = ['#00EC97', '#FF3DBB', '#FFF5FB', '#0A0410']
  const ps = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 4,
    vy: 3 + Math.random() * 5,
    a: Math.random() * 6,
    c: cols[Math.floor(Math.random() * cols.length)]!,
  }))
  let frame = 0
  let raf = 0
  const step = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const p of ps) {
      p.x += p.vx
      p.y += p.vy
      p.a += 0.12
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.a)
      ctx.fillStyle = p.c
      ctx.fillRect(-5, -3, 10, 6)
      ctx.restore()
    }
    if (++frame < 220) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}

export function JackpotOverlay({ event, quip, me, nextRound, startPrice, onClose }: { event: Settled; quip: string; me: string | null; nextRound: number; startPrice: string; onClose: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const { winner, jackpot, multiple } = event.data
  const mine = !!me && winner === me

  // showModal puts the overlay in the top layer, above a Challenge or Deposit dialog that is already open.
  useEffect(() => {
    const d = dlg.current
    if (d && !d.open) d.showModal()
    btn.current?.focus()
    const t = setTimeout(() => close.current(), AUTO_CLOSE_MS)
    const onCancel = (e: Event) => {
      e.preventDefault()
      close.current()
    }
    d?.addEventListener('cancel', onCancel)
    const stop = canvas.current && !reducedMotion() ? confetti(canvas.current) : () => {}
    return () => {
      clearTimeout(t)
      d?.removeEventListener('cancel', onCancel)
      if (d?.open) d.close()
      stop()
    }
  }, [event.id])

  return (
    <dialog ref={dlg} className="jackpot" aria-labelledby="jp-title">
      <div className="megaburst" aria-hidden="true" />
      <canvas ref={canvas} className="confetti" aria-hidden="true" />
      <div className="jp-in">
        <h2 id="jp-title" className="jp-big">
          {winner ? (
            <>
              Jack
              <br />
              pot
            </>
          ) : (
            <>
              Roll
              <br />
              over
            </>
          )}
        </h2>
        <div className="jp-amt">
          <RollingNumber value={money(jackpot)} />
        </div>
        <p className="jp-who">{winner ? (mine ? 'You take the pot' : `${winner} takes it`) : 'Nobody held the throne'}</p>
        {winner && <p className="jp-sub">{multiple.toFixed(1)}x the last ticket</p>}
        <p className="jp-quip">{quip}</p>
        <button ref={btn} type="button" className="btn-rug is-dark" onClick={() => close.current()}>
          <span>Run it back</span>
          <span>{money(startPrice)}</span>
        </button>
        <p className="jp-next">Round {nextRound} is open at {money(startPrice)}.</p>
      </div>
    </dialog>
  )
}
