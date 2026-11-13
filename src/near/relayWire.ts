// How a signed delegate action travels from the browser to the relayer: plain JSON that both
// sides rebuild with near-api-js, so the relayer needs no extra decoder. The rebuilt delegate
// must serialize to exactly the bytes the player signed, or the chain rejects it.

import { KeyType, PublicKey, Signature, actions, base64Decode, base64Encode, buildDelegateAction, type Action, type SignedDelegate } from 'near-api-js'

export type WireAction =
  | {
      type: 'call'
      methodName: string
      /** The call's raw JSON arguments, base64. */
      args: string
      gas: string
      deposit: string
    }
  /** Only function-call keys travel: a full-access key is never added through the relayer. */
  | { type: 'addKey'; publicKey: string; receiverId: string; methodNames: string[]; allowance: string }
  | { type: 'deleteKey'; publicKey: string }

export interface WireDelegate {
  senderId: string
  receiverId: string
  nonce: string
  maxBlockHeight: string
  publicKey: string
  actions: WireAction[]
  /** The ed25519 signature, base64. */
  signature: string
}

function actionToWire(a: Action): WireAction {
  if (a.functionCall) {
    const c = a.functionCall
    return { type: 'call', methodName: c.methodName, args: base64Encode(c.args), gas: c.gas.toString(), deposit: c.deposit.toString() }
  }
  if (a.addKey) {
    const fc = a.addKey.accessKey.permission.functionCall
    if (!fc || fc.allowance === undefined) throw new Error('Only function-call keys with an allowance can be added through the relayer.')
    return { type: 'addKey', publicKey: a.addKey.publicKey.toString(), receiverId: fc.receiverId, methodNames: [...fc.methodNames], allowance: fc.allowance.toString() }
  }
  if (a.deleteKey) return { type: 'deleteKey', publicKey: a.deleteKey.publicKey.toString() }
  throw new Error('Only function calls and key changes can be relayed.')
}

function actionFromWire(w: WireAction): Action {
  switch (w.type) {
    case 'call':
      return actions.functionCall(w.methodName, base64Decode(w.args), BigInt(w.gas), BigInt(w.deposit))
    case 'addKey':
      return actions.addFunctionCallAccessKey(PublicKey.fromString(w.publicKey), w.receiverId, w.methodNames, BigInt(w.allowance))
    case 'deleteKey':
      return actions.deleteKey(PublicKey.fromString(w.publicKey))
  }
}

export function toWire(signed: SignedDelegate): WireDelegate {
  const d = signed.delegateAction
  return {
    senderId: d.senderId,
    receiverId: d.receiverId,
    nonce: d.nonce.toString(),
    maxBlockHeight: d.maxBlockHeight.toString(),
    publicKey: d.publicKey.toString(),
    actions: d.actions.map(actionToWire),
    signature: base64Encode(signed.signature.data),
  }
}

export function fromWire(w: WireDelegate): SignedDelegate {
  const delegateAction = buildDelegateAction({
    senderId: w.senderId,
    receiverId: w.receiverId,
    nonce: BigInt(w.nonce),
    maxBlockHeight: BigInt(w.maxBlockHeight),
    publicKey: PublicKey.fromString(w.publicKey),
    actions: w.actions.map(actionFromWire),
  })
  // `SignedDelegate` is type-only in near-api-js's runtime exports; the action builder makes one.
  const signature = new Signature({ keyType: KeyType.ED25519, data: base64Decode(w.signature) })
  const built = actions.signedDelegate({ delegateAction, signature }).signedDelegate
  if (!built) throw new Error('Could not rebuild the signed delegate.')
  return built
}
