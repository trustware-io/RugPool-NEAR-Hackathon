# Release status and reproduction

## Status, 2026-11-12

Source release prepared for public publication as `hlassige/RugPool-NEAR-Hackathon`. A hosted demo and separate testnet deployment remain pending. No mainnet deployment or real Intents delivery is claimed. No tests, builds, installs, network access or signing were performed during the original packaging step. Publication uses GitHub separately; prior passes are retained, not rerun or renamed acceptance tests.

Prior independent evidence recorded November 11–12: frontend 182 tests/typecheck/build; 117 RugPool unit plus 2 token tests; keeper 44 doctests and 10 exit tests; selected local-chain regressions, 15 caught mutations and local-chain E2E; four separately run live-drand tests; scoped draw-storage review; nine synthetic keeper command-boundary cases. Local E2E substitutes identity and wallet keys, not live Privy/email. Gas at 500 depositors is extrapolated from 10/70, not an executed 500-player run.

Exact captured predecessor WASM `f0716ef483b121def3b31599c5fd940861a17f2336d9713b5744554d5f97357a` migrated atomically in one populated offline representative fixture to authentic current artifact `5654b21d3fd65c2f98856da6cfa527119b8eb110ab8473531fbad800cef2d665`; 1 test passed. This does not establish live-state migration, every state shape, source/build attribution of the older deployment, or already-in-flight legacy callbacks across upgrade. The attempted M10 rebuild did not match captured deployed bytes. No WASM from those experiments is distributed here as a release build.

External keeper signing/monitoring, current external Privy/wallet flow and hosting remain unverified. Keeper uses `sign-with-legacy-keychain`; recorded relayer provisioning used system-keychain. Relayer itself reads a JSON private_key from NEAR_CREDENTIALS_DIR. These interfaces are not interchangeable. Do not export or move keys to work around this without explicit approval. `keeper --once` can SEND; it is not a dry-run. Existing keeper comments/examples and application default accounts retain historical identifiers because logic is unchanged; use explicit approved release configuration, never run against old pool2 by accident.

## Reproduction instructions (not executed in packaging)

Use an isolated development environment with Node 24, npm compatible with the included lockfile, Rust 1.93.0 and wasm32-unknown-unknown target. Python 3.9+ is used for keeper checks. Prior contract tooling used NEAR sandbox 2.13.4 and cargo-near 0.23.0; dependency versions are in Cargo.lock. Provisioning tools/dependencies requires its own permission in the current agent session. No dependencies or binaries are vendored.

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

Expected output locations: `contract/target/wasm32-unknown-unknown/release/rugpool.wasm` and `test_usdc.wasm`. Record full SHA-256 and exact toolchain/flags before selecting any deployment artifact. These are reproducible instructions, not a claim of deterministic binary equivalence to an older deployment. Prefer a fresh output directory over any experiment cache. Never use generic cached WASM: a prior generic artifact was a fault-injected derivative.

For test and local-chain instructions, see README.md. Use `cargo test --locked -p rugpool -p test-usdc` from contract/. Local-chain examples produce disposable `.localnet` keys and state; those are never release contents. Some integration tests need public beacon access. No further execution is authorized merely by documenting these commands.

## Later release sequence

1. Owner confirms repository owner/name and visibility, separate testnet accounts, signing custody, transaction/funding caps and hosting. No real-value or mainnet scope implied.
2. Publish only this source tree after final local source/privacy review; preserve this provenance. Do not publish the surrounding packaging/evidence directory.
3. Separately authorize dependency setup/build if needed; capture and approve exact release WASM hashes. Deploy new token/pool accounts, never upgrade existing pool2. Initialize `new`, not `migrate`, on a new pool, with owner-approved token, owner, timings, limits, relayers and no real Intents configuration.
4. Configure explicitly approved new account IDs in private local configuration and public browser values, provision relayer/keeper custody through an approved backend, then configure hosting. Persistent relayer ledger and secrets stay out of Git/static hosting.
5. Record deployment receipts/code hashes and truthful status. A login/gameplay acceptance walkthrough is further testing and needs fresh permission. Human supplies/publishes demo and confirms exact submission payload separately.
