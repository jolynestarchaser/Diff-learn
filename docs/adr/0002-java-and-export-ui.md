# ADR 0002: Java syntax profiles and a read-only export UI

Accepted: 5 October 2026. The user's current priority supersedes the earlier single-milestone order. Hosted Linux verification remains pending and does not gate this slice.

## Java compatibility and evidence versions

Pin `tree-sitter-java@0.23.5` with the existing `tree-sitter@0.21.1`, TS/TSX 0.23.2 and JavaScript 0.23.1. The installed Java parser declares ABI 14 and its published peer range is `^0.21.1`. Installation with lifecycle scripts disabled loaded the Windows x64 native prebuild and actually parsed a Unicode record/compact constructor on Node 24.20.0. Darwin, Linux and Windows x64/arm64 prebuilds are present in the package; their presence is not a claim of execution on those platforms. Native Linux/hosted CI remains unverified.

| Version | Contract |
| --- | --- |
| 1.0.0 | Unchanged default Git facts and IDs |
| 1.1.0 | Frozen TS/TSX/JS syntax schemas and three-grammar capability table |
| 1.2.0 | Frozen candidate/history extension of 1.1.0 |
| 1.3.0 | Java-aware syntax, four-grammar table, additional kinds and optional exact `signatureDisplay` |

The syntax writer selects 1.3.0 when requested analyses include Java source sides; TS/TSX/JS-only exports retain 1.1.0. Existing candidate flags continue writing 1.2.0 using its historical language profile; Java is explicitly unsupported in that profile. Java reference/JUnit heuristics and a later candidate version are follow-up work. No historical schema is widened, and default Git/hunk payloads and ID functions remain unchanged. Syntax IDs include their actual declaration data. The shared `readEvidenceBundle` dispatcher serves CLI review and UI, using version-owned schemas/capabilities without importing native parsers. Synthetic frozen 1.0/1.1/1.2 exports exercise this boundary.

Java extraction uses the installed grammar's node types and fields. It observes package/import syntax, classes/interfaces/records/enums, annotation types/elements/usages, methods/constructors, fields/components/constants, initializers and nested local/anonymous/lambda boundaries. Annotations have no inferred runtime meaning. Multi-field declarations share the authoritative declaration range but retain each declared name. Ordinary local variables are not fields. Unnamed boundaries use null names. Type/member headers sharing a line with nested declarations are retained alongside innermost containers; a body-only change does not imply a type-header change.

Overloads/repeated kind/name/scope groups remain ambiguous, including unchanged siblings. Unique method/constructor pairs additionally require identical displayed parameter syntax; signature changes may remain unmatched. Pairings are syntactic candidates, never semantic identities, resolved callers, behavior or test coverage. Exact before/after bytes, hashes, UTF-8 byte coordinates, scopes and hunk IDs come through the existing collector. Lossy encoding, normalization disagreement, syntax errors and bounds retain explicit limitations and supported peer evidence. Real mutation still discards the whole snapshot.

Primary sources: [pinned grammar](https://github.com/tree-sitter/tree-sitter-java/tree/v0.23.5), [node types](https://github.com/tree-sitter/tree-sitter-java/blob/v0.23.5/src/node-types.json), [published package manifest](https://github.com/tree-sitter/tree-sitter-java/blob/v0.23.5/package.json).

## Export session and bridge

`dr ui --evidence <export.json>` loads one bounded, regular, non-symlink UTF-8 JSON file through the shared validator. Invalid/unknown versions fail startup visibly; invalid data never reaches the browser as trusted evidence. The accepted bundle is frozen for the session. Later file edits do not refresh it. This explicit export mode has no workspace root binding, Git collection, arbitrary file read, execution, review writes or refresh endpoint.

The subsequent local-startup brief adds bare `dr` as a separate mode of the same bridge. It resolves one canonical worktree from cwd, starts the production app before collection, opens the default browser, and collects guarded `all` evidence against HEAD with syntax internally. Only authenticated, exact-origin, body-free POST `/api/refresh` starts a new collection of that fixed worktree. One collection runs at a time; validated immutable projection generations retain the current and previous snapshot so requests never join unrelated captures. Frontend preparation publishes the whole visible snapshot together. Failure retains the last valid snapshot; Ctrl+C aborts collection and closes the loopback listener. No arbitrary root/path read, automatic watch, review write or acknowledgment is added.

Use Node's HTTP server at `127.0.0.1` on an ephemeral port, with bundled Vite production assets. React/Vite/browser tooling are development-only; installed consumers do not need a development server or frontend dependencies. No remote fonts, analytics or assets are loaded.

Host must exactly equal the bound IPv4 loopback address/port. Origin, when supplied, must be the exact session origin; cross-site Fetch Metadata requests are rejected. All API requests require a random 256-bit per-session header token, bootstrapped only in same-origin HTML, never in URLs, logs, exported evidence or clipboard text. No CORS permission is supplied. CSP disallows framing, object content, external connections and inline executable code except the nonce-protected bootstrap. Responses are no-store with nosniff/referrer/embedding restrictions. Only explicit asset-map names and evidence IDs are accepted; no path-to-filesystem route exists. Requests, pagination and responses are bounded. Export sessions expire after 30 minutes; bare local sessions last until terminal shutdown. Ctrl+C/abort closes either mode without removing workspace data.

| GET endpoint | Projection |
| --- | --- |
| `/api/session` | Capture/version/coverage/capabilities; freshness explicitly not verified |
| `/api/repositories` | Paginated outcomes, retaining failures |
| `/api/files?repositoryId=...` | Paginated authoritative file facts and path/change filters |
| `/api/hunks?fileEvidenceId=...` | Paginated original hunks/lines |
| `/api/inspect?evidenceId=...` | Original selected record, related declarations/analysis and diagnostics |
| `/api/state` | Mode, actual root/branch/scope, collection phase, generation, accepted session or actionable error |

Local mode also accepts body-free, exact-Origin authenticated POST `/api/refresh`, returning 202 after starting collection or 409 if already active. Export mode has no Refresh endpoint. Projection requests may pin `generation`; current/previous accepted generations are retained, expired/unknown generations return 409 and duplicate/invalid values are rejected. Generation belongs to the transport, not to historical evidence schemas/IDs.

Projections retain original IDs, coordinates, provenance and completeness. The UI shows only collected hunks and labels gaps. Split presentation aligns records by ordinal within changed runs, not by invented semantic matching. Binary/gitlink/mode-only/no-hunk/unavailable states use metadata. Source text is React text content, never executable HTML/Markdown. Clipboard handoff is bounded plain text with original evidence IDs, capture/scopes, coverage and an untrusted-source reminder; it contains no session token and never marks review state. Clipboard refusal provides selectable text.

Verification must cover native parsing, historical readers without parsers, Git ID preservation, bridge rejection cases, frozen sessions, production browser interaction, Thai/keyboard/responsive states and the actual installed tarball command/assets. A screenshot alone does not establish correctness.
