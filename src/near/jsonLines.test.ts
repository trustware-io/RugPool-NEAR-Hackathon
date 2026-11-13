import { describe, expect, it } from 'vitest'
import { parseJsonLines } from './jsonLines'

describe('parseJsonLines', () => {
  it('reads every complete record', () => {
    expect(parseJsonLines('{"a":1}\n{"a":2}\n')).toEqual({ records: [{ a: 1 }, { a: 2 }], skippedTail: null })
    expect(parseJsonLines('')).toEqual({ records: [], skippedTail: null })
  })

  it('skips a partial last line left by a crash mid-append', () => {
    expect(parseJsonLines('{"a":1}\n{"a":')).toEqual({ records: [{ a: 1 }], skippedTail: '{"a":' })
  })

  it('throws on damage anywhere else', () => {
    expect(() => parseJsonLines('{"a":1}\nnot json\n{"a":2}\n')).toThrow(/line 2/)
    expect(() => parseJsonLines('{"a":1}\n{"a":\n')).toThrow(/line 2/)
  })
})
