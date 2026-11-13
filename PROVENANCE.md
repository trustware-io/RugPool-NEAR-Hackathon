# Source provenance

Packaged 2026-11-12. This is a source-only release of prior work, not a representation that the project began November 1.

Original repository: https://github.com/hlassige/rugpool-app (private preservation). Candidate base: `edbc4f03138c83cc28e7552ea0dcf9ac0363dd9d`, with seven existing uncommitted changes: README.md, contract/rugpool/src/lib.rs, contract/rugpool/tests/court.rs, package-lock.json, package.json, src/components/Footer.tsx, tsconfig.json. This package copies the working candidate, not HEAD alone.

Original source documentation records work starting October 21, continuing October 21–29 and November 7–12, 2026. The October 23 rewrite plan was superseded; a fresh release repository does not change authorship dates or eligibility. Local organizer rules FAQ Q-001 allow code from October 19, Q-003 does not require a new repository. Live rules still need confirmation before submission.

Application, contract, relayer, keeper, tests, toolchain/dependency lockfiles and the patched executor are copied byte-for-byte. Root LICENSE retains Copyright (c) 2026 Harrison Lassige; THIRD_PARTY_NOTICES.md retains Peerfolio's notice, and the executor retains patch attribution. No upstream notices or dates were removed.

Original Git history, planning drafts, rehearsal logs, screenshots/mockups and internal independent reviews remain preserved in the original project/evidence locations. They are not included because this is a minimal source release, not an evidence archive. No history was rewritten or deleted. No compiled WASM is included; a filename in a cache is not release provenance.

Intentional differences: README.md reconciles existing evidence and pending release status; .env.example uses inactive placeholders for a separate new testnet instead of old pool2 defaults; .gitignore adds secret/runtime/build exclusions. PROVENANCE.md, RELEASE.md and RELEASE_MANIFEST.json are new. Package and Cargo project names/repository metadata remain unchanged as source attribution. This tree is prepared for publication at https://github.com/trustware-io/RugPool-NEAR-Hackathon; the remote's existence and exact commit must be verified separately.

RELEASE_MANIFEST.json records every payload file's SHA-256, original SHA-256 when copied, and equality/change category. The manifest excludes itself to avoid self-hashing. Packaging verification is not a fresh runtime acceptance or an audit.
