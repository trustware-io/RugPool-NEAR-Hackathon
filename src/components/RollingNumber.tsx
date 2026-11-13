import { useRef } from 'react'

const DIGITS = '0123456789'.split('')

/**
 * Slot-reel digits: each digit is a 0-9 column that rolls to its value. The blur
 * keyframe alternates names on every change so the browser restarts it.
 */
export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const prev = useRef<{ value: string; flips: number[] }>({ value, flips: [] })
  const chars = [...value]
  if (prev.current.value !== value) {
    const old = [...prev.current.value]
    // Align from the right so "$9.99" -> "$10.00" keeps the cents columns in place.
    const offset = chars.length - old.length
    prev.current.flips = chars.map((c, i) => (prev.current.flips[i - offset] ?? 0) + (old[i - offset] !== c ? 1 : 0))
    prev.current.value = value
  }
  return (
    <span className={`roll ${className ?? ''}`}>
      <span className="sr">{value}</span>
      {chars.map((c, i) =>
        /\d/.test(c) ? (
          <span className="roll-d" key={chars.length - i} aria-hidden="true">
            <span className="roll-s" data-p={prev.current.flips[i] ? prev.current.flips[i]! % 2 : undefined} style={{ transform: `translateY(-${Number(c) * 10}%)` }}>
              {DIGITS.map((d) => (
                <i key={d}>{d}</i>
              ))}
            </span>
          </span>
        ) : (
          <span className="roll-c" key={`c${chars.length - i}`} aria-hidden="true">
            {c}
          </span>
        ),
      )}
    </span>
  )
}
