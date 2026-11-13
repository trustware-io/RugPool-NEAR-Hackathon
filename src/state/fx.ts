// Sound, haptics and the reduced-motion gate. CSS media queries cannot stop JS effects,
// so every JS-driven effect checks `reducedMotion()` itself.

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function buzz(ms = 12): void {
  if (reducedMotion()) return
  // Browsers block vibration until the user has interacted with the page.
  if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.hasBeenActive) return
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(ms)
}

type Cue = 'hit' | 'rugged' | 'alarm' | 'jackpot' | 'coin'

let ctx: AudioContext | null = null
let enabled = false

/** Must run inside a user gesture, or the AudioContext stays suspended. */
export async function setSound(on: boolean): Promise<void> {
  enabled = on
  if (!on) return
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  play('coin')
}

export function soundOn(): boolean {
  return enabled
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain = 0.08, slideTo?: number): void {
  if (!ctx) return
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, start)
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur)
  g.gain.setValueAtTime(gain, start)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  o.connect(g).connect(ctx.destination)
  o.start(start)
  o.stop(start + dur + 0.02)
}

export function play(cue: Cue): void {
  if (!enabled || !ctx) return
  const t = ctx.currentTime
  switch (cue) {
    case 'hit':
      tone(880, t, 0.09, 'square', 0.06, 440)
      tone(1320, t + 0.06, 0.12, 'square', 0.05)
      break
    case 'rugged':
      tone(330, t, 0.35, 'sawtooth', 0.07, 110)
      break
    case 'alarm':
      for (let i = 0; i < 4; i++) tone(i % 2 ? 660 : 990, t + i * 0.18, 0.16, 'square', 0.06)
      break
    case 'jackpot':
      ;[523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.09, 0.3, 'triangle', 0.08))
      break
    case 'coin':
      tone(988, t, 0.06, 'square', 0.05)
      tone(1319, t + 0.06, 0.18, 'square', 0.05)
      break
  }
}
