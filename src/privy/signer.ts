// Signs NEAR transactions with the player's Privy wallet right in the page, the way the
// privy-near-connect sign page does (Privy's embedded-wallet iframe plus `rawSign` of the
// transaction hash). Sign-in uses it to add the RugPool session key with no popup.

import Privy, { rawSign } from '@privy-io/js-sdk-core'
import { PublicKey, Signer, baseEncode } from 'near-api-js'

/** A Privy NEAR wallet: its Privy id and its implicit account (the ed25519 public key, hex). */
export interface PrivyNearWallet {
  id: string
  address: string
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) throw new Error('Privy returned a malformed signature.')
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16))
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export class PrivyNearSigner extends Signer {
  private readonly privy: Privy
  private readonly wallet: PrivyNearWallet

  constructor(privy: Privy, wallet: PrivyNearWallet) {
    super()
    this.privy = privy
    this.wallet = wallet
  }

  async getPublicKey(): Promise<PublicKey> {
    return PublicKey.fromString(`ed25519:${baseEncode(fromHex(this.wallet.address))}`)
  }

  /** near-api-js passes the SHA-256 hash of the transaction or delegate action. */
  protected async signBytes(hash: Uint8Array): Promise<Uint8Array> {
    const { data } = await rawSign(this.privy, (request) => this.privy.embeddedWallet.signWithUserSigner(request), {
      wallet_id: this.wallet.id,
      params: { hash: `0x${toHex(hash)}` },
    })
    return fromHex(data.signature)
  }
}

let mounted: Promise<void> | null = null

/** Mounts Privy's hidden embedded-wallet iframe once; signing goes through it. */
export function mountPrivyWallet(privy: Privy): Promise<void> {
  mounted ??= new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.src = privy.embeddedWallet.getURL()
    iframe.style.display = 'none'
    window.addEventListener('message', (event) => {
      if (event.source === iframe.contentWindow) privy.embeddedWallet.onMessage(event.data)
    })
    iframe.addEventListener(
      'load',
      () => {
        privy.setMessagePoster({
          postMessage: (msg, origin, transfer) => iframe.contentWindow?.postMessage(msg, origin, transfer ? [transfer] : undefined),
          reload: () => {
            iframe.src = privy.embeddedWallet.getURL()
          },
        })
        resolve()
      },
      { once: true },
    )
    document.body.appendChild(iframe)
  })
  return mounted
}
