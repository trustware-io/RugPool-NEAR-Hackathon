// The one place that knows whether the app runs on mocks or on the contract.
// `VITE_STORE=contract` uses the RugPool contract on NEAR testnet; anything else uses the mocks.

import { MockDepositService } from '../deposit/mockDeposit'
import { NearDepositService } from '../deposit/nearDeposit'
import type { DepositService } from '../deposit/types'
import { ContractStore } from '../game/contractStore'
import { MockStore } from '../game/mockStore'
import { DEMO_PARAMS, SPEC_PARAMS, isFastMode } from '../game/params'
import type { GameStore } from '../game/types'
import { Near, nearConfigFromEnv } from '../near/near'
import { privyFromEnv } from '../privy/privySession'

export const fastMode = isFastMode()

interface MockControls {
  botsOn(): boolean
  setBots(on: boolean): void
}

function build(): { store: GameStore; deposits: DepositService; mockControls: MockControls | null; contractId: string | null } {
  if (import.meta.env.VITE_STORE === 'contract') {
    const near = new Near(nearConfigFromEnv())
    return { store: new ContractStore(near, privyFromEnv()), deposits: new NearDepositService(near), mockControls: null, contractId: near.config.rugpool }
  }
  // Module scope, so React StrictMode's double effects never build a second engine.
  const mock = new MockStore({ params: fastMode ? DEMO_PARAMS : SPEC_PARAMS, seed: true })
  mock.start()
  return {
    store: mock,
    deposits: new MockDepositService((account, amount, msg) => mock.ftOnTransfer(account, amount, msg)),
    mockControls: { botsOn: () => mock.botsEnabled(), setBots: (on) => mock.setBots(on) },
    contractId: null,
  }
}

const services = build()

export const store: GameStore = services.store
export const deposits: DepositService = services.deposits

/** Mock-only controls for the footer. `null` on the contract. */
export const mockControls = services.mockControls

/** The RugPool contract account on the contract, `null` on mocks. */
export const contractId = services.contractId

export const withdrawCooldownLabel = contractId ? '60 seconds (rehearsal contract)' : fastMode ? '60 seconds (demo timing)' : '24 hours'
