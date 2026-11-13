// @privy-io/js-sdk-core expects a global Buffer in the browser. Imported first so the global
// exists before the SDK's modules evaluate.
import { Buffer } from 'buffer'

;(globalThis as Record<string, unknown>).Buffer = Buffer
