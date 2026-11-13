# Release status and reproduction

## Published source and evidence scope

Baseline `080ed6fafb4cea6ea7e296cbd3611e18868cf1bc` was published on November 12 following scoped independent review. The automatic-rules and Court withdrawal changes are now included in this public repository; their evidence scope is described below. The recorded testnet deployment and bounded single-player walkthrough predate that workflow. No public hosted demo, mainnet deployment or real Intents delivery is claimed.

### Rules and withdrawal workflow

The workflow adds automatic rules preferences and one-start Court withdrawal with finalized-receipt and snapshot-freshness checks. Recorded scoped independent code review and 51 focused tests passed, along with browser checks for rules/preferences, keyboard interaction, synthetic withdrawal lifecycle, reduced motion and cooperating tabs. Withdrawal browser checks use authentic components with a synthetic adapter, not live payments. Narrow desktop-browser viewport coverage is not physical-mobile verification. The November 12 live payout evidence below does not test this newer workflow.

Prior independent evidence recorded November 11–12: frontend 182 tests/typecheck/build; 117 RugPool unit plus 2 token tests; keeper 44 doctests and 10 exit tests; selected local-chain regressions, 15 caught mutations and local-chain E2E; four separately run live-drand tests; scoped draw-storage review; nine synthetic keeper command-boundary cases. Local E2E substitutes identity and wallet keys, not live Privy/email. Gas at 500 depositors is extrapolated from 10/70, not an executed 500-player run.

Exact captured predecessor WASM `f0716ef483b121def3b31599c5fd940861a17f2336d9713b5744554d5f97357a` migrated atomically in one populated offline representative fixture to authentic current artifact `5654b21d3fd65c2f98856da6cfa527119b8eb110ab8473531fbad800cef2d665`; 1 test passed. This does not establish live-state migration, every state shape, source/build attribution of the older deployment, or already-in-flight legacy callbacks across upgrade. The attempted M10 rebuild did not match captured deployed bytes. No WASM from those experiments is distributed here as a release build.

The live pass used existing isolated role custody: keeper CLI legacy-keychain files and relayer JSON private_key from NEAR_CREDENTIALS_DIR, outside this repository. These interfaces are not interchangeable. Do not export or move keys to work around configuration without explicit approval. `keeper --once` can SEND; it is not a dry-run. Existing keeper comments/examples and application default accounts retain historical identifiers because logic is unchanged; use explicit approved release configuration, never run against old pool2 by accident.

## Testnet deployment and bounded live acceptance (November 12 EST)

Fresh pool `pool.rugpool-release-20261112.testnet` and token `tusdc.rugpool-release-20261112.testnet` were deployed with `new`, not an upgrade/migration. Both deployed binaries were independently downloaded and hash-matched at finalized block277452821:

| Artifact | SHA-256 |
|---|---|
| Pool | `5654b21d3fd65c2f98856da6cfa527119b8eb110ab8473531fbad800cef2d665` |
| Test token | `0f798610daa79642b685f4adfa5dd31ca94a1ad3518a62fb3d8071aaedd0a042` |

At deployment, all 16 retained contract source pins matched the reviewed source tree; pool lib SHA-256 `4311a56cc1eabc8c049b91a6bbeda255ce5fef722940b77a2bc3e89c04728ee4`. Authentic retained artifacts were used, not a new reproducibility build. Token is publicly mintable6-decimal tUSDC, not real USDC. Contracts retain account keys and are upgradeable. Intents configuration is null. Demo timings:60s withdrawal cooldown/showdown,15s snipe,180s backstop,10min draw interval; registration fee0, funded yield reserve0.

Deployment transactions (independently checked FINAL with successful receipts):
- Token deploy/init: `6SKAoQ1XJygb8TGaRTBJkUFe3AF2dgQGyRzXCGJhxcoa`.
- Pool deploy/init: `AgLH4MLbtijkVkdE13H1CwfbbiBJRPYVArjV2QQuc9M5`.
- Pool token-storage registration: `472AqiH4nrx7VwmreTYKmZ5uo5ETpFAJEep1CAdYg6xt`.

Human-operated email login/activation and Court30/Game10 deposits were followed by one5tUSDC challenge. The manually invoked, bounded keeper sent only `settle_round` (30Tgas,0NEAR attached): `D5G9KXm69AWs7roKiPrYyLVzAakjo1qqnBcsUfWsBR3h`, signer `keeper.rugpool-release-20261112.testnet`. Independent RPC returned FINAL success and all successful receipt outcomes. Jackpot4tUSDC was credited internally before Claim, not immediately paid to the wallet. No always-on keeper is deployed; no claim of live draw completion or exercised alert delivery.

**Final exit state:** observed2026-11-13T03:48:11.759003Z (November12 EST), finalized block277457159, hash `3dm7meeYFdEBz9NbGzrVB7LQCvdpsmGfzqP8p5UEYEEb`, via `https://rpc.testnet.near.org`. Player `9b7f2514f67202a2b468ad93e037664d59601d351ea0c296dc844372f7f985b1`: wallet99.375tUSDC; Game0, Court0, earned0, stream0, pending withdrawal0, readiness null. Previous post-Claim wallet69.375 increased by exactly30. Latest payout ID3 has no remaining record; in-flight liability0. Pool625000base units equals liabilities375000draw pot +250000treasury exactly. This is snapshot solvency, not a perpetual guarantee; player exit does not mean the pool is empty.

**Evidence limit:** claim and final withdrawal are confirmed by finalized balance/accounting effects, not recovered transaction hashes/receipts. The keeper receipt proves settlement only. Completed payout callbacks remove records; application event IDs are not transaction hashes. No private browser/log recovery or broad chain search was used. This accepts the bounded single-player path, not multiplayer, auto-defend, live draw, mainnet, Intents, Google login, upgrade compatibility or production readiness.

Half-speed UI/rules were checked in built React with pointer/keyboard coverage; the integrated contract-mode build passed (1547 modules, with dependency externalization and large-chunk warnings). Focused auth checks and independent auth review passed at pinned source. These are recorded checks, not a fresh run of the historical suite. The walkthrough used loopback frontend port 5181 and relayer port 5187 for a finite runtime window, not a permanently available judge URL. Demo delivery and final submission are separate from this testnet evidence.

## Unresolved dependency advisories

This unaudited testnet release retains three unresolved version-applicable advisories. None was demonstrated as a RugPool exploit by the bounded static review; this is not production or real-funds security clearance.

- **wee_alloc 0.4.5 — critical, [GHSA-rc23-xxgq-x27g](https://github.com/advisories/GHSA-rc23-xxgq-x27g).** near-sdk 5.29.1 defaults select it as the wasm32 global allocator in both contracts. This is a real source-defined runtime dependency, not merely test tooling. The advisory concerns abandonment/reported leaks, with no patched release or demonstrated RugPool exploit. Deployed binary inclusion was not freshly inspected. Reviewed allocator removal/replacement, rebuild and validation are required before real-funds acceptance.
- **zod 3.25.76 — high, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).** The browser Privy→api-base dependency falls within the published affected range. The reviewed scalar APIError schema does not establish a reachable attacker-sized affected collection parse. Conditional memory-exhaustion risk remains open; use an upstream-compatible remediation, not an untested forced v3→v4 override.
- **elliptic 6.6.1 — low, [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84).** The transitive Peerfolio→old near-js crypto→secp256k1 dependency contains affected ECDSA signing. Reviewed RugPool session/signing uses Ed25519; JWT verification uses WebCrypto, not elliptic signing. Vulnerable signing reachability and key compromise were not demonstrated. Keep the advisory open pending supported dependency replacement; dependency presence alone is not evidence requiring key rotation.

Review scope: public baseline 080ed6, static dependency/source analysis, not exploit reproduction or final bundle/dead-code proof. Future dependency/source changes require a new disposition.

## Reproduction instructions

Use an isolated development environment with Node 24, npm compatible with the included lockfile, Rust 1.93.0 and wasm32-unknown-unknown target. Python 3.9+ is used for keeper checks. Prior contract tooling used NEAR sandbox 2.13.4 and cargo-near 0.23.0; dependency versions are in Cargo.lock. Tool/dependency provisioning requires network access. No dependencies or binaries are vendored.

From package root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Frontend output is `dist/`. Serve it over HTTPS only when hosting is approved. VITE configuration is compiled into the public browser bundle; never put signing keys or privileged provider tokens there.

Locked contract release builds, from package root after authorized toolchain setup:

```sh
RUSTFLAGS='-C link-arg=-s --cfg near' cargo +1.93.0 build --locked --manifest-path contract/Cargo.toml -p rugpool -p test-usdc --lib --target wasm32-unknown-unknown --release
```

Expected output locations: `contract/target/wasm32-unknown-unknown/release/rugpool.wasm` and `contract/target/wasm32-unknown-unknown/release/test_usdc.wasm`. Record full SHA-256 and exact toolchain/flags before selecting any deployment artifact. These instructions do not establish deterministic binary equivalence to an older deployment. Use a fresh output directory; do not deploy unverified cached or fault-injected test artifacts.

For test and local-chain instructions, see [README.md](README.md). Use `cargo test --locked -p rugpool -p test-usdc` from `contract/`. Local-chain examples produce disposable `.localnet` keys and state; keep them out of releases. Some integration tests need public beacon access.

## Operator deployment safeguards

Use separate testnet accounts, explicit funding/transaction limits and verified release WASM hashes. Initialize a fresh pool with `new`, not `migrate`; do not target the old pool2 defaults. Configure the token, owner, timings, limits and authorized relayers explicitly, with no real Intents configuration. Persistent relayer ledgers and signing credentials must stay outside Git and static hosting. Record deployment receipts and code hashes; deployment alone does not establish gameplay acceptance or authorize mainnet use.
