import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRulesOptOut, writeRulesOptOut, RULES_OPT_OUT_KEY } from './rulesPreference'

afterEach(() => vi.unstubAllGlobals())

describe('local rules preference', () => {
  it('defaults to showing rules without browser storage', () => {
    expect(readRulesOptOut()).toBe(false)
    expect(writeRulesOptOut(true)).toBe(false)
  })
  it.each([null, '', 'false', 'garbage'])('shows rules for non-opt-out value %s', (value) => {
    vi.stubGlobal('localStorage', { getItem: () => value })
    expect(readRulesOptOut()).toBe(false)
  })
  it('persists only explicit opt-out and removes it when unchecked', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    expect(writeRulesOptOut(true)).toBe(true)
    expect(values.get(RULES_OPT_OUT_KEY)).toBe('true')
    expect(readRulesOptOut()).toBe(true)
    expect(writeRulesOptOut(false)).toBe(true)
    expect(readRulesOptOut()).toBe(false)
    expect(values.size).toBe(0)
  })
  it('fails safely if storage is denied or full', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('full') },
      removeItem: () => { throw new Error('denied') },
    })
    expect(readRulesOptOut()).toBe(false)
    expect(writeRulesOptOut(true)).toBe(false)
    expect(writeRulesOptOut(false)).toBe(false)
  })
})
