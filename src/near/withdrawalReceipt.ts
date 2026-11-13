// Read-only reconciliation of the already-submitted OUTER transaction. For a
// delegated action its signer is the relayer, not the player's account.
// No signing, resend, authority renewal, raw response/error logging or storage.
export async function finalizedWithdrawalReceipt(
  raw: unknown, contract: string, method: 'request_withdraw' | 'withdraw',
  query: (args: { txHash: string; accountId: string; waitUntil: 'FINAL' }) => Promise<unknown>,
  guard: () => void,
) {
  type Envelope = { final_execution_status?: string; transaction?: { hash?: string; signer_id?: string } }
  const original = raw as Envelope | null
  const id = original?.transaction?.hash
  const signer = original?.transaction?.signer_id
  const unknown = { kind: 'unknown' as const, id }
  try {
    guard()
    if (original?.final_execution_status === 'FINAL') return withdrawalReceipt(raw, contract, method)
    if (typeof id !== 'string' || !id || typeof signer !== 'string' || !signer) return unknown
    // At most three status reads, each bounded to 10s, with 1s between reads.
    // The controller's original 60s total send deadline still dominates.
    for (let attempt = 0; attempt < 3; attempt++) {
      guard()
      let timer: ReturnType<typeof setTimeout> | undefined
      let response: unknown
      try {
        response = await Promise.race([
          query({ txHash: id, accountId: signer, waitUntil: 'FINAL' }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10_000) }),
        ])
      } catch { /* transient/not-yet-known RPC result; never resubmit */ }
      finally { clearTimeout(timer) }
      guard()
      const value = response as Envelope | null
      if (value?.final_execution_status === 'FINAL') {
        if (value.transaction?.hash !== id || value.transaction.signer_id !== signer) return unknown
        return withdrawalReceipt(response, contract, method)
      }
      if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 1_000))
    }
  } catch { /* stopped/expired/replaced authority: retain uncertainty and identifier */ }
  return unknown
}

// Narrow receipt parsing: never fall back to the outer relayer transaction's status.
export function withdrawalReceipt(raw: unknown, contract: string, method: 'request_withdraw' | 'withdraw') {
  type Receipt = { id?: string; block_hash?: string; outcome?: { executor_id?: string; status?: { SuccessReceiptId?: string; SuccessValue?: string; Failure?: unknown } } }
  const value = raw as { final_execution_status?: string; transaction?: { hash?: string }; receipts_outcome?: Receipt[] } | null
  const id = value?.transaction?.hash
  // Execution (including EXECUTED/INCLUDED_FINAL) is not finalized settlement.
  if (value?.final_execution_status !== 'FINAL') return { kind: 'unknown' as const, id }
  const receipts = value?.receipts_outcome ?? []
  const root = receipts.find(r => r.outcome?.executor_id === contract)
  let r = root
  let followed = false
  const seen = new Set<Receipt>()
  while (r?.outcome?.status?.SuccessReceiptId && !seen.has(r)) {
    seen.add(r); followed = true
    const next = r.outcome.status.SuccessReceiptId
    r = receipts.find(v => v.id === next)
  }
  const status = r?.outcome?.status
  if (status?.Failure !== undefined) return { kind: followed ? 'unknown' as const : 'rejected' as const, id }
  if (r?.outcome?.executor_id !== contract || typeof status?.SuccessValue !== 'string') return { kind: 'unknown' as const, id }
  if (method === 'request_withdraw' && !followed && root?.block_hash && status.SuccessValue === '') return { kind: 'requested' as const, id, block: root.block_hash }
  if (method === 'withdraw' && followed) {
    try {
      const result: unknown = JSON.parse(atob(status.SuccessValue))
      if (result === true) return { kind: 'paid' as const, id }
      if (result === false) return { kind: 'restored' as const, id }
    } catch { /* missing/unparseable terminal evidence stays unknown */ }
  }
  return { kind: 'unknown' as const, id }
}
