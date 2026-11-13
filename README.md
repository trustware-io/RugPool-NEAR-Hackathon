# RugPool

A king-of-the-hill game on NEAR. Players pay a rising price to take the throne, and the last King standing when the clock runs out wins the Jackpot. To play, you keep a refundable deposit in the Court, which earns a share of every ticket and enters a weekly draw without spending your Court principal. Funds remain exposed to contract, token, storage and operator risks.

Built at NEAR HACKATHON for the `games` track.

Source release packaged 12 November 2026 from the existing November project. See [PROVENANCE.md](PROVENANCE.md) and [RELEASE.md](RELEASE.md).

## Status

Read this first. It says what works and where.

| Part | State |
|---|---|
| Game contract (Rust, `contract/rugpool`) | Implemented; prior independent local execution and scoped draw-storage review passed. Not audited or accepted for production. |
| App (React, `src/`) | Half-speed UI/rules integrated; actual contract-mode build passed. Human email-login and single-player testnet path exercised; see RELEASE.md for evidence limits. |
| Gas relayer and account activation (`scripts/relayer.ts`) | Used in the bounded local testnet walkthrough with real human login. Loopback-only service, not public hosting. |
| Keeper and solvency monitor (`scripts/keeper.py`) | One manually invoked bounded settlement finalized successfully; read/solvency checks passed. Not an always-on keeper or tested alerting service. |
| NEAR testnet | Fresh `pool.rugpool-release-20261112.testnet` and `tusdc.rugpool-release-20261112.testnet` deployed and initialized; deployed WASM hashes verified against authentic artifacts. See RELEASE.md. |
| NEAR mainnet | Not deployed. |
| NEAR Intents deposits | Designed for, not live. See [NEAR Intents](#near-intents). |
| Hosted demo | None. |
| Audit | None. The contract is unaudited. |

## How the game works

**A round**

1. The first challenge costs \$5. Each challenge costs 3% more than the last. The price resets every round.
2. Whoever challenges becomes King. A ticket splits four ways: 55% to the Jackpot, 25% to the King you dethroned, 15% to the Court, 5% to the protocol.
3. The showdown starts when the Jackpot reaches 0.2% of the Court, or when the round is 6 hours old. It lasts 10 minutes. A challenge in the last 60 seconds pushes the end back to 60 seconds.
4. When the showdown ends, the King gets the Jackpot and a new round opens at \$5.

**Auto-defend.** You set a maximum price. If someone dethrones you, the contract retakes the throne for you in the same transaction, up to that price. A single transaction runs at most 25 retakes.

**The Court**

- You need \$25 in the Court to challenge. It is refundable: you ask to withdraw, wait out a cooldown, then withdraw.
- Court deposits earn the Court's share of tickets. They also earn yield while a yield reserve is funded.
- Once a week, part of the Court's share is paid to one depositor in a draw. Nobody loses their deposit in it: "no-loss" describes the draw's accounting, not a guarantee against contract, token, storage or operator risk. Odds follow deposit size times time held. It takes \$5 to enter, and the draw holds 500 entrants.
- The draw's winner is picked by [drand](https://drand.love) randomness. The contract names a future drand round when the draw closes, then checks that round's signature on chain.

**Tickets are spent.** You can lose them. Nothing here promises a return.

## Try it

Use Node 24 and npm with the included lockfile. Local-chain steps also need Rust 1.93.0 and the wasm32-unknown-unknown target; see [reproduction prerequisites](RELEASE.md#reproduction-instructions-not-executed-in-packaging). Python 3.9+ is needed for keeper checks. Prior chain tooling used NEAR sandbox 2.13.4 and cargo-near 0.23.0. Initial dependency/tool provisioning needs network access; some contract integration tests also retrieve public drand data.

### 1. The game on mocks (2 minutes, no chain)

Run these commands from the repository root. The browser-only simulation needs no Privy setup, relayer or funded account.

```
npm ci
VITE_STORE=mock npm run dev
```

Open the address Vite prints and add `?fast=1` to it, for example `http://localhost:5173/?fast=1`. That uses short demo timings.

On first visit, read and close the rules dialog before using Connect. The optional local opt-out suppresses automatic reopening; the footer rules button remains available.

- **See:** a round already in progress. Bots are challenging each other, the Jackpot is rising, and the live feed is scrolling.
- **Do:** click **Connect**. **See:** the button becomes **Deposit**.
- **Do:** click **Deposit**, then **Confirm deposit**. **See:** "Credited \$29.91 to the Court". That is your refundable Court deposit.
- **Do:** click **Challenge now**. **See:** a dialog saying your game balance is \$0.00. Tickets are paid from the game balance, not the Court.
- **Do:** click **Top up balance**, then **Confirm deposit**. **See:** "GAME \$29.91" in the header.
- **Do:** close the dialog, click the large price button under the Jackpot, then **Challenge for \$…**. **See:** the live feed says "you rugged …", and your game balance drops by the ticket price. A bot with auto-defend armed may retake the throne at once; the feed shows that too.
- **See, over the next minutes:** the showdown clock. A challenge in its last 15 seconds resets it to 0:15.

Confirm each deposit within 30 seconds of opening its dialog. The mock's quote expires after that and the deposit fails with "Quote expired".

Everything in this mode is simulated in the browser, including the deposit. The deposit dialog's "from any chain" wording describes the intended design, not something this build does.

Mock balances, deposits, bots, yield and payouts are simulated. Mock Claim/withdrawal credits internal game balance, not an external wallet; it is not payout or NEAR Intents evidence.

### 2. The contract, relayer and money path on a local NEAR chain (about 5 minutes)

This runs the real contract on a real local NEAR node, with the real relayer in front of it. Use two terminals.

Terminal 1, leave it running:

```
cd contract
cargo run -p rugpool --example localnet -- --accounts 4 --port 3031
```

Terminal 2, from the repository root (not `contract/`), once terminal 1 has written `.localnet/localnet.json`:

```
PRIVY_VERIFICATION_MODE=pem node --experimental-strip-types --no-warnings --import ./scripts/ts-resolve.mjs scripts/e2e-slice.ts
```

- **See:** 38 lines starting with `PASS` and no `FAIL`. The script exits non-zero on the first failure and writes `.localnet/e2e-result.json`.
- **What it does:** a new player is activated, signs in with a session key, deposits, joins the Court, challenges, wins the round, claims, withdraws, and signs out. Every game action goes through the relayer, so the player pays no gas. After each money step it checks that the contract holds exactly what it owes.
- **What is simulated:** the identity provider and the player's wallet. A throwaway key stands in for Privy's token signer, and a local key for the player's Privy wallet. The chain, contracts, relayer, signatures and nonces are real.

### 3. The test suites

```
npm test
npm run typecheck
python3 -m doctest scripts/keeper.py
python3 -m unittest discover -s scripts -p 'test_keeper.py'
cd contract && cargo test -p rugpool -p test-usdc
```

Prior independent evidence includes 182 frontend tests, 44 keeper doctests, 10 keeper exit tests, 117 contract unit tests plus 2 test-token tests, selected local-chain regressions, 15 mutation detections, local E2E and four separately executed live-drand tests. These are separate recorded runs, not a newly executed aggregate suite. See RELEASE.md for scope and limits, including the later focused auth checks and integrated build. No tests or builds were run during the original source-packaging step; commands above are reproduction instructions, not authorization to run them in the current work session. Contract integration tests require a local NEAR sandbox, and some retrieve public drand data.

### 4. Owner-operated release testnet (not a self-service judge demo)

Judges can reproduce the browser simulation and local-chain path above. The deployed testnet walkthrough below is dated evidence, not an available hosted service. Contract mode requires an owner-provisioned, funded and pool-authorized relayer; selecting a wallet instead of Privy does not make the supported gas-relayed game path self-contained. No relayer key or live service is distributed with this release.

For a separately authorized operator setup, set public frontend values `VITE_STORE=contract`, `VITE_RUGPOOL_CONTRACT=pool.rugpool-release-20261112.testnet`, `VITE_USDC_CONTRACT=tusdc.rugpool-release-20261112.testnet` and `VITE_RELAYER_URL` to that operator's relayer URL. The historical local pairing was frontend `http://localhost:5181` and relayer `http://localhost:5187`; these are not promised live endpoints. Pass the exact frontend origin `http://localhost:5181` as the relayer's allowed-origin argument for that pairing; localhost and 127.0.0.1 are not interchangeable origins. Do not use old pool2 defaults.

The relayer reads `<relayer-account>.json` with a `private_key` from server-side `NEAR_CREDENTIALS_DIR`, and needs a persistent private `RELAYER_DATA_DIR` with one owning process. Its account requires testnet NEAR for relay gas and approved activation budgets. Keep credentials and ledgers outside Git/static hosting; never put them in VITE values or export existing keys to satisfy this recipe. Email activation additionally requires matching public frontend `VITE_PRIVY_APP_ID` and server `PRIVY_APP_ID`, approved Privy origins and explicit verification mode below. Without Privy, the app offers wallet selection, not a funded relayer service. This section describes operator prerequisites, not a turnkey judge setup or permission to provision/sign.

The November 12 walkthrough used `http://localhost:5181/` with a loopback relayer on port5187 and a finite runtime window, not a permanent public demo. It exercised Court30/Game10 deposits, one5tUSDC challenge, manual keeper settlement, Claim and Court withdrawal. Final wallet99.375tUSDC and zero player balances/pending withdrawal were verified at finalized block277457159. Claim/withdraw effects are state-confirmed; their transaction receipts were not recovered. The token is publicly mintable **test tUSDC, not real USDC**. Demo configuration uses60-second showdown/withdrawal cooldown,15-second snipe,180-second backstop and10-minute draw interval, unlike the general timings above. Draw completion and multiplayer/auto-defend were not exercised in this live pass.

### Relayer identity verification

Set server-side `PRIVY_APP_ID` to the same public app ID as the frontend and explicitly set `PRIVY_VERIFICATION_MODE=jwks`. The verifier fetches only `https://api.privy.io/v1/apps/<configured-app-id>/jwks.json`; token headers cannot supply a key URL. It accepts matching ES256/P-256 signing keys, caches them for 10 minutes, and refreshes an unknown `kid` at most once per 30 seconds. Fetches time out after 5 seconds, reject redirects, and limit responses to 64 KiB and 32 keys. A newly rotated key may be refused during the refresh cooldown. Fetch/validation failures fail closed; unexpired cached keys remain usable without fetching.

For intentionally pinned, offline verification, use `PRIVY_VERIFICATION_MODE=pem` with `PRIVY_VERIFICATION_KEY` containing the public SPKI PEM. There is no automatic fallback between modes. Existing launch environments with only app ID and PEM must add `PRIVY_VERIFICATION_MODE=pem`. No app secret is used. Neither mode replaces the existing email and exact linked-NEAR-account activation checks.

Focused offline authentication checks (locally generated fixture keys/tokens, not real Privy login):

```sh
node --experimental-strip-types --import ./scripts/ts-resolve.mjs --test scripts/check-identity-jwks.ts
```

## How NEAR is used

- **Email login with no wallet and no gas.** A player signs in with an email code through [Privy](https://www.privy.io), which gives them a NEAR account. The relayer checks the Privy identity token, funds that account once with a small amount of NEAR, and from then on pays the gas for every action.
- **Meta transactions (NEP-366).** The browser signs each action as a delegate action. The relayer checks it against a fixed policy and submits it.
- **Function-call access keys as session keys.** Sign-in adds a key that can call only the game's six methods, with a 1 yoctoNEAR allowance, so it cannot pay for its own transactions and only works through the relayer. The relayer expires it after about a week, and sign-out deletes it.
- **A trusted-relayer check in the contract.** Under NEP-366 a relayed call's signer is whoever relayed it. Calls that spend, lock or delay a player's money are accepted only from the game's own relayers. Paying a player what they are already owed works through any relayer.
- **drand verified on chain.** The draw checks a drand quicknet signature with NEAR's BLS12-381 host functions, so the current contract gives no block producer, keeper or owner a way to pick the winner. Whoever can replace the contract's code is a separate trust assumption.
- **NEP-141.** Money is a 6-decimal USDC token, deposited with `ft_transfer_call`.

### NEAR Intents

The design is cross-chain deposits and withdrawals through NEAR Intents: a player pays in any supported asset, and Intents delivers USDC to the game contract with a message naming the player.

What exists today:

- The contract has a deposit path for Intents deliveries. An Intents delivery cannot be refunded, so this path is designed to credit the named player, or hold the amount for the owner to return, rather than reject it.
- That path is tested with a stand-in account playing the Intents contract, not with a real Intents delivery. Whether it succeeds at runtime, and how a real delivery behaves when it fails, are unverified.

What does not exist: NEAR Intents has no testnet, and this project has not been deployed to mainnet. No real Intents delivery has been made. The app's deposit dialog does not call Intents.

## Risks and who you trust

The app shows these under **Risks and who you trust**, next to the rules.

- **Unaudited and upgradeable.** Whoever holds the contract account's key can replace its code.
- **The owner can pause new play:** challenges, Court joins and deposits. The pause does not disable claims or withdrawals, though a storage shortage or a failed payout can still stop one from completing. A showdown already running still ends on time. The owner collects the protocol's 5% and can take back the yield reserve.
- **The draw depends on drand.** If drand never publishes the round a draw named, that draw's pot stays locked. The current contract has no owner method to release a draw without that round's signature. This was a deliberate choice. Whoever can replace the contract's code is a separate trust assumption, listed above.
- **Yield comes from a funded reserve.** When it is empty, yield stops. It never comes from deposits.
- **A stuck payout is settled by the owner.** Payouts started by this version are recorded until their outcome is booked. If that step does not complete, the amount stays on the contract's books and the owner can settle the record by hand after an hour, from the chain's record of whether the transfer went through. The contract cannot check the owner's answer. The fresh release uses this recorded-payout build; historical old-pool payouts are outside its recovery/monitoring coverage.
- **Storage.** The contract pays for its own storage in NEAR, and players do not. If it runs short, new deposits, Court joins, arming auto-defend and freezing a new draw stop until it is topped up. Challenges, claims and withdrawals are not paused, but they still need enough NEAR for what they store. If the remaining storage is used up, they can fail until the contract is topped up. The buffer does not guarantee that exits are available. Someone could cause a shortage on purpose by creating many small accounts.
- **Email logins depend on Privy and the relayer.** Privy manages the account's key. While the relayer is down, an email player cannot challenge or ask to withdraw. A claim, or a withdrawal whose cooldown has ended, can go through any relayer.
- **The relayer trusts public RPC endpoints.** Before it re-sends an activation payment, it needs two different endpoints to agree the first one failed. Two endpoints run by the same operator would not be independent.

## Known gaps

- Three unresolved dependency advisories remain; see [versions, severities and reachability limits](RELEASE.md#unresolved-dependency-advisories). No production-security clearance is claimed.
- The relayer is one process with its ledger in local files. It was run only on loopback for bounded acceptance, not publicly hosted; its per-address limits are in memory.
- One bounded keeper settlement was sent and verified FINAL. Continuous operation, draw execution and monitor alert delivery were not accepted by that pass.
- The older callback path, kept for payouts in flight during an upgrade, trusts any call from the contract's own account. The plan is that no full-access key remains on that account after the upgrade. That has not been set up or checked.
- The old testnet code hash was captured. An offline populated representative fixture under those exact bytes atomically upgraded and migrated to the authentic current artifact successfully. This is not a migration of live pool state, source/build attribution, or a deployment of this package.
- Local-chain failed token-transfer/retry and fault-injected current callback recovery evidence exists. A legacy callback already in flight across an upgrade remains unverified. Fresh deployment and single-player live acceptance do not establish upgrade safety or full production acceptance.
- A frozen draw may require a native NEAR top-up to finalize if storage headroom is exhausted. No funding-free liveness guarantee is made. The 500-player gas figure in the unchanged keeper comment is an extrapolation from 10/70-depositor measurements, not a 500-player execution.
- The draw walks every depositor, which is why it holds 500 entrants.
- Google sign-in through Privy has not been tried. Human email sign-in was used in the November12 release walkthrough. Historical automated local E2E still uses synthetic identity/wallet keys; it is separate evidence.
- The UI can lag at a zero countdown until refreshed state arrives. No functional timer change was made in the Half-speed visual work.
- Wallet sign-in (without Privy) asks the wallet for the same restricted key, but a wallet may ignore the 1 yoctoNEAR allowance.

## What was built in the hackathon window

This is a fresh source-only release of an existing October–November project, not a new November 1 project. The source README records the original first commit on 21 October 2026, after the announcement on 19 October. Dependencies and the patched executor have their own provenance and notices. The locally supplied organizer rules say code from October 19 counts (FAQ Q-001), a new repository is not required (Q-003), testnet is eligible (Q-010), and no integration is mandatory (Q-011). The live rules were not refreshed during this offline packaging stage.

- **21 to 29 October:** the contract, the app, the relayer and the local chain, built milestone by milestone. Original history and the rehearsal log remain preserved in the original project, outside this release package.
- **7 to 10 November:** identity binding for activation, relayed deposits and sign-in, session-key expiry, the trusted-relayer check, safe re-sending of activation payments, the storage buffer, payout records, the keeper's monitor, and the risk disclosures.

Original repository: <https://github.com/hlassige/rugpool-app> (private preservation repository; not a public judge-accessible history link). See PROVENANCE.md for the exact candidate base and packaging boundary.

Earlier planning drafts and original history are preserved outside this source release. Development began in October; publication in a fresh repository does not change that provenance.

The source-only packaging manifest establishes copied-file provenance, not a publicly inspectable development-window diff. The original development history remains private; this release does not yet supply the public baseline/window comparison described in Q-003. The recorded October 21 start lies inside Q-001's October 19 eligibility window, but the absence of earlier first-party baseline work has not been independently established by this public package.

## Libraries and AI use

**AI.** Claude Code assisted implementation, directed and reviewed by the author. Friday/Hermes independently reviewed selected checkpoints and executed the scoped local checks summarized in RELEASE.md, and prepared this package. Prior independent runtime passes do not establish an audit, production readiness or current external deployment acceptance.

**Contract:** [near-sdk](https://github.com/near/near-sdk-rs) and near-contract-standards 5.29. Tests use near-sandbox, near-api and cargo-near-build.

**App and relayer:** React 19, Vite 8, TypeScript 7, [near-api-js](https://github.com/near/near-api-js) 7.3.1, [@hot-labs/near-connect](https://www.npmjs.com/package/@hot-labs/near-connect) 0.11.4, [@privy-io/js-sdk-core](https://www.npmjs.com/package/@privy-io/js-sdk-core) 0.72.1, [@peerfolio/privy-near-connect](https://www.npmjs.com/package/@peerfolio/privy-near-connect) 0.0.8, buffer. Tests use Vitest 5.

`public/privy-near-connect-executor-0.0.8-patched.js` is a patched copy of a file from `@peerfolio/privy-near-connect`. The original accepted result messages from any window; the patch accepts them only from its parent.

**Keeper:** Python 3.9 standard library, and [near-cli-rs](https://github.com/near/near-cli-rs) to sign.

## Where things are

| Path | What |
|---|---|
| `contract/rugpool/src/lib.rs` | The game contract, with its unit tests |
| `contract/rugpool/src/drand.rs` | drand signature verification |
| `contract/rugpool/tests/` | Tests on near-sandbox |
| `contract/rugpool/examples/localnet.rs` | The local chain, with optional bots |
| `contract/test-usdc/` | A test USDC token |
| `src/` | The app |
| `src/near/` | Relayer logic shared with the app: identity, activation, payment settlement, session keys, relay policy |
| `scripts/relayer.ts` | The relayer service |
| `scripts/keeper.py` | The keeper and solvency monitor |
| `scripts/e2e-slice.ts` | The end-to-end run from step 2 |
| `PROVENANCE.md`, `RELEASE.md` | Source provenance, release status and reproducible build instructions |

## License

MIT. See `LICENSE`.

`public/privy-near-connect-executor-0.0.8-patched.js` is derived from `@peerfolio/privy-near-connect` 0.0.8. Its upstream copyright and MIT license notice are kept in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). RugPool's changes are identified at the top of the file.
