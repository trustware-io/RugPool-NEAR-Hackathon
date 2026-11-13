// Browser-local UI preference only; no account identity or remote tracking.
export const RULES_OPT_OUT_KEY = 'rugpool.rules.dontShowAgain.v1'

export function readRulesOptOut(): boolean {
  try {
    return localStorage.getItem(RULES_OPT_OUT_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeRulesOptOut(optOut: boolean): boolean {
  try {
    if (optOut) localStorage.setItem(RULES_OPT_OUT_KEY, 'true')
    else localStorage.removeItem(RULES_OPT_OUT_KEY)
    return true
  } catch {
    return false
  }
}
