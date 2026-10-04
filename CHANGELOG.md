# Changelog

## Unreleased — v0.1 preparation

### Explicit local-review milestone

- Added `review mark/list/reset` over explicitly exported concrete evidence snapshots, with independent schema 1.0.0 local state/output and English/Thai human messages.
- Added deterministic context/byte fingerprints, conservative one-to-one hunk continuity, isolated repository/worktree/branch/base/scope contexts, and unseen status for incomplete, repeated or ambiguous hunks.
- Added locked, flushed atomic replacement, visible corrupt/version-incompatible state and interrupted-writer handling, strict input bounds, and synthetic continuity/failure fixtures. Evidence/context remain read-only and reviewed is not a correctness claim.

### v0.2 candidate discovery and bounded history (opt-in)

- Added `evidence/context --references`, `--related-tests`, and `--history`, implying syntax analysis with independent bounded query/result/commit limits and schema 1.2.0.
- Added verified tracked after-endpoint corpora, shell-free structured fixed-string rg candidates, snapshot/range/hash provenance, duplicate/cross-repository name disclosure, missing-tool/error/truncation diagnostics and separate completeness.
- Added explained filename/text/static-relative-import test heuristics labeled not-run; search absence does not prove missing tests or coverage gaps.
- Added pinned-HEAD literal original/destination path history with full commit/parent IDs and explicit shallow/N+1 bounds. No repository programs run, no semantic references/LSP/contract analysis or additional grammars are added.

### First v0.2 milestone (opt-in)

- Added a capability/result/diagnostic `LanguageAnalyzer` contract and compatible pinned Tree-sitter TS/TSX/JS grammars.
- Added scope-correct blob/index/retained-working source analysis inside snapshot verification, syntax declarations/imports/top-level mapping, deleted occurrences, ranges/hashes and explicit errors/ambiguous pairing.
- Added `evidence/context --symbols`, schema 1.1.0 syntax coverage/observations and cited localized context, preserving default v0.1 data/schema. Behavior/contracts, semantic references, LSP and other grammars remain unsupported.

Current package version: `0.1.0-dev.0`. No public GitHub or npm release has been made.

- Added single strict TypeScript package and `dr` commands: scan, status, diff, evidence, context, help and version.
- Added validated workspace configuration, per-repository bases, bounded repository discovery and distinct worktree identities.
- Added direct branch/staged/unstaged/all comparisons, optimistic snapshots, authoritative Git metadata, unified hunks, conflict facts and opt-in filesystem text.
- Added versioned runtime-validated evidence, deterministic IDs, provenance, explicit partial failures and limits, and escaped English/Thai context.
- Added synthetic Git fixtures, Windows/Linux Node 24.20.0 CI, package-content inspection and isolated packed-binary verification.
- Added MIT license, usage/contribution documentation and agent-consumption guidance.

v0.1 does not analyze changed symbols, references, behavior, return types, impact, test coverage, history or review state. Symbols/references/history remain v0.2; review state remains v0.3. Package/binary working-name checks and hosted CI results remain release gates; see CONTRIBUTING.
