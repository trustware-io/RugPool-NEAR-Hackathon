// Display helpers. Money arrives as micro-USDC (number or 6-decimal string).

const USD = 1_000_000

export function micro(v: string | number): number {
  return typeof v === 'number' ? v : Number(v)
}

export function money(v: string | number, digits = 2): string {
  const n = micro(v) / USD
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * USD)
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  if (d > 0) return `${d}d ${h % 24}h`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function pct(bps: number, digits = 1): string {
  return (bps / 100).toFixed(digits) + '%'
}
