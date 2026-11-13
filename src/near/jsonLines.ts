// Parses an append-only JSON-lines file. A crash mid-append can leave the last line partial;
// that one is skipped (and reported) so the relayer still starts. A bad line anywhere else
// means the file was damaged some other way, so it throws rather than guess.

export function parseJsonLines<T>(text: string): { records: T[]; skippedTail: string | null } {
  const lines = text.split('\n')
  const lastFull = text.endsWith('\n') ? lines.length - 1 : lines.length
  const records: T[] = []
  let skippedTail: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    try {
      records.push(JSON.parse(line) as T)
    } catch (e) {
      if (i === lastFull - 1 && !text.endsWith('\n')) {
        skippedTail = line
        continue
      }
      throw new Error(`Damaged record on line ${i + 1}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return { records, skippedTail }
}
