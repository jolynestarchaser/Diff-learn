# ADR 0001: Read-only Git evidence contract

Status: Accepted v0.1 design; implementation and release verification are tracked in progress. Date: 4 October 2026.

## Context and decision

Developers need reproducible evidence across repositories, including committed changes in an otherwise clean worktree. Git comparisons, repository discovery, mutable files, and partial failures must have one contract shared by JSON, terminal output, and agent context. Adopt a single TypeScript package with a local Git subprocess adapter, validated versioned evidence, bounded optimistic snapshots, and explicit coverage. The [implementation plan](../implementation-plan.md) records compatible packages, sequencing, and release checks. No CLI is implemented by this ADR.

## 1. Commands and configuration

| Command | Result and supported options |
| --- | --- |
| `dr scan` | Repository inventory and discovery coverage; no base resolution or diff. |
| `dr status` | HEAD/branch, branch changed-file metadata, and separate staged/unstaged/untracked/conflict status. Branch comparison is required; no patch content. |
| `dr diff` | Files and unified hunks for the selected scope, plus separately labeled untracked/conflict metadata. |
| `dr evidence [--json]` | Full v0.1 evidence bundle; JSON is the default, `--json` is explicit/idempotent. |
| `dr context` | Escaped Markdown from the same bundle, with evidence IDs, scope/revisions, diagnostics, and coverage; no reasoning or tutor execution. |

All commands accept `--root <directory>` (default cwd), `--config <file>`, repeatable `--repo <workspace-relative-path>`, `--lang en|th` (default en), `--max-depth <n>`, and `--concurrency <n>`. `scan`, `status`, and `diff` also accept `--json`; `context --json` is invalid. `status`, `diff`, `evidence`, and `context` accept `--base <revision>`. Only `diff`, `evidence`, and `context` accept `--scope branch|staged|unstaged|all` (default all), `--include-untracked`, `--max-file-bytes`, and `--max-patch-bytes`. Unknown/inapplicable flags, extra positional arguments, invalid enums, duplicate scalar flags, and nonpositive limits are errors (depth may be zero). `--help`/`--version` exit 0 without discovery.

`--root` and `--config` resolve relative to invocation cwd; canonicalize root before traversal. Default config is exactly `<root>/.difflearn.json`, never ancestor/home/repo-local auto-loading. Missing default config means defaults; missing explicit config is error 2. Reject unknown keys, unsupported versions, duplicate JSON keys, duplicate logical repository keys, escaping paths, and invalid values. No environment-variable config layer. CLI values override workspace config; configured repository bases have the special precedence below. Parse JSON only; no executable config or YAML.

```json
{
  "configVersion": "1",
  "base": "origin/development",
  "lang": "en",
  "repositories": [
    { "path": "service-a", "key": "service-a", "base": "origin/main" },
    { "path": "service-a-worktree", "key": "service-a-worktree" }
  ],
  "excludeDirectories": ["vendor"],
  "excludePaths": ["archive"],
  "limits": { "maxDepth": 8, "concurrency": 4, "maxFileBytes": 2097152 }
}
```

`repositories` supplies overrides, not a scan allowlist; omitted repositories are still discovered. `path` is the exact workspace-relative repository root, `.` for a root repository, with `/` separators. Optional `key` is a unique nonempty logical identifier, defaulting to that path; it is independent of base/branch and never taken from a remote URL. Configured but missing/excluded repositories receive diagnostics, not silent deletion. `--repo` selects exact paths after discovery, never globs or arbitrary Git pathspecs; unmatched selections are error 2. No matches because discovery failed is operational error 1. CLI `--base` applies to every selected repository; scope it to one with `--repo`.

Exclusions use literal directory-component names and literal root-relative subtree paths; no glob syntax/dependency. User values add to the built-in discovery exclusions `.git`, `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.test-dist`, `.difflearn`, `.aws`, `.ssh`, `.codex`, and `.agents`. Exclusions affect discovery and untracked inclusion, never hide tracked diffs. Config discovery exclusions are policy scope and listed in coverage.

## 2. Base resolution, independently per repository

Choose the first supplied level, resolve once to a full commit OID, and record input plus `resolutionSource`:

1. CLI `--base` for the selected set.
2. Exact repository config `base`.
3. Workspace config `base`.
4. Locally stored symbolic `refs/remotes/origin/HEAD`; if absent, a single other remote HEAD symbolic ref.
5. Otherwise `BASE_REQUIRED`; multiple other remote HEAD candidates give `BASE_AMBIGUOUS`.

An invalid/missing chosen ref is `BASE_UNRESOLVED`; never fall through to a lower choice. Reject ambiguous abbreviated ref names (branch/tag collisions); full refs, unambiguous revisions resolving to one commit, annotated tags peeled to commits, and full OIDs are accepted. Revisions are separate from paths: use `rev-parse --verify --end-of-options <revision>^{commit}`, then OIDs for comparisons. Never guess main/master/development, substitute the tracking branch, fetch, or access remotes. Mark remote freshness `not-verified` and retain the resolved local OID.

Git's `for-each-ref` omits dangling symbolic refs. Automatic fallback therefore also probes configured remote HEAD names and bounded loose-ref names, verifying each with `symbolic-ref`; a missing target cannot silently disappear from candidate counts. Symlink/inaccessible/over-budget loose-ref enumeration is an explicit failure. For a non-files ref backend, v0.1 cannot prove complete fallback enumeration when fewer than two candidates are visible: mark base unavailable (`BASE_UNRESOLVED`) and request an explicit base, rather than claiming a unique/default candidate. Explicit bases and an existing symbolic origin HEAD still work through Git for that backend.

For committed comparisons resolve HEAD `H`, base `B`, and `merge-base --all B H`. Exactly one merge-base `M` is required: zero gives `NO_MERGE_BASE` (include shallow-history state), multiple gives `MULTIPLE_MERGE_BASES`. Do not select an arbitrary ancestor or use fork-point heuristics. Missing objects, shallow boundaries, and corrupt refs are diagnostics, not a clean result. [Git revision verification](https://git-scm.com/docs/git-rev-parse), [merge-base ambiguity](https://git-scm.com/docs/git-merge-base).

## 3. Comparison algebra and special states

`I` is the captured index; `W` is Git's index-aware tracked working-tree view. The comparison table defines direct invocations with fixed common options omitted for readability:

| Scope | Before -> after | Direct Git comparison |
| --- | --- | --- |
| branch | `M -> H` | `git diff M H --` |
| staged | `H -> I` | `git diff --cached H --` |
| unstaged | `I -> W` | `git diff --` |
| all | `M -> W` | `git diff M --` |

`all` includes staged additions and their current worktree content, and Git's handling of index removals; it excludes genuinely untracked files. A staged deletion followed by an untracked recreation remains a tracked deletion plus a separate untracked record. Reverting committed/staged edits in the worktree can cancel the net patch. Never concatenate the other scopes or replace merge-base with base tip. `status` presents branch metadata and index/worktree XY facts independently; it never equates clean worktree with no branch changes. [Git's comparison forms](https://git-scm.com/docs/git-diff).

Base is required only for branch/all and the branch component of status. For explicit staged/unstaged, optional base-resolution failures are warning diagnostics with branch capability unavailable, while the requested local comparison can be complete. In an unborn repository, HEAD is null: staged uses `git diff --cached --` (Git's empty-tree baseline), unstaged remains valid, branch/all are unavailable with `UNBORN_HEAD`. Record an `empty-tree` before side, not a fabricated SHA-1 or HEAD. Detached HEAD records `headState: detached`, null branch, and its full OID; all scopes work when their inputs resolve. An ordinary merge commit is supported as a two-tree comparison; combined/per-parent merge patches are outside v0.1.

Unmerged index paths carry conflict facts with stage 1/2/3 mode/OIDs (missing stages null) and XY status. Keep unaffected paths, but omit ordinary local file/hunk evidence for conflicted paths; staged/unstaged/all completeness is partial with `UNMERGED_PATH`. Never choose ours/theirs or parse combined patches as two-sided hunks. Branch-only immutable comparison may still be complete despite separate conflict metadata. Intent-to-add uses explicit `--ita-visible-in-index` with a capability check and recorded policy (staged sees an empty addition); fixture-test this experimental Git option. Sparse checkout, skip-worktree, and assume-unchanged are recorded; v0.1 marks working comparisons unavailable for affected paths rather than claiming full filesystem coverage.

## 4. Git execution, files, and parser contract

Require Git >=2.49. Invoke the executable directly using `spawn` argument arrays, `shell: false`, explicit cwd, and no interpolated shell strings. Clear inherited Git repository/index/config/trace override variables so a caller's `GIT_DIR` cannot redirect collection or tracing write files; use `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_REPLACE_OBJECTS=1`, no pager/color, `core.fsmonitor=false`, and `core.untrackedCache=false`. Never checkout, reset, stash, stage, commit, refresh the real index, run hooks/tests/scripts, or write scanned repositories. Respect Git dubious-ownership checks; report failure instead of disabling `safe.directory`. Disable lazy object fetching with `GIT_NO_LAZY_FETCH=1`, prohibit transport protocols, and disable terminal prompts; test that missing promisor objects do not cause a network request. [Git 2.49 options/environment contract](https://git-scm.com/docs/git/2.49.0).

Use `status --porcelain=v2 -z --branch --untracked-files=all --ignore-submodules=none`, `ls-files --stage -z`, and `diff --raw -z`/`--numstat -z` for metadata. Parse fixed record fields and NUL filenames, including multi-path rename records; never infer authoritative filenames from patch headers. Preserve full Git OIDs and object format (SHA-1/SHA-256), old/new modes, statuses `A/M/D/R/T/U`, rename source/destination and similarity score. Copies are not detected in v0.1.

Pin `--no-ext-diff --no-textconv --no-color --no-relative --diff-algorithm=myers --no-indent-heuristic --find-renames=50% -l1000 --submodule=short --ignore-submodules=none --src-prefix=a/ --dst-prefix=b/ --unified=3 --full-index`. Override user whitespace-ignore, prefix, context, rename, and ordering settings; record effective options/attributes/config hashes. Preflight rename candidate counts: exceeding the 1,000-candidate budget disables rename detection for that comparison and marks it partial with `RENAME_LIMIT`; retain additions/deletions, not invented renames. Rename facts mean Git detected similarity, not proof that the developer moved a file.

Status metadata additionally uses `--no-patch` after the pinned context flag, `--abbrev=64`, and `-O/dev/null` to cancel configured ordering (including Git for Windows). Branch/staged metadata uses `--attr-source=<captured-HEAD-OID>` when HEAD exists; immutable attributes come from that commit, with guarded info/global attributes. Working comparisons use guarded current attributes. This keeps immutable metadata available when mutable directory components are unsafe. Working status/comparisons may conservatively be withheld for the whole repository when any restricted tracked path exists. Parent submodule dirty-state queries first inspect initialized child config/index metadata for active filters and unsafe directory components; nested gitlinks are explicitly unsupported for working coverage in v0.1, without exporting child source content. [Git attribute source](https://git-scm.com/docs/git), [index flags](https://git-scm.com/docs/git-ls-files).

Git attributes can execute clean/process filters even when external diff/textconv is disabled. Inspect effective filter configuration before any status/worktree diff; override every configured driver's clean/process command to empty and required flag to false in collector invocations. Flag paths using active filters (including LFS) as unsupported for working comparisons and working-status coverage; never emit the resulting passthrough observations as canonical Git facts. Branch/staged blob evidence remains available. Capture/recheck attributes/config; test sentinel filters and fsmonitor never execute. Git's built-in EOL/ident/encoding transformations are recorded as part of the comparison policy; raw filesystem hash is distinct from Git-normalized blob identity. [Attributes/filter behavior](https://git-scm.com/docs/gitattributes).

Parse unified two-sided hunks into ranges `{start,count}`, ordered context/add/remove lines, and per-side no-final-newline markers; zero counts are valid. Hunk header trailing text is untrusted display text, never symbol evidence. Join patch sections with raw metadata using decoded Git quoting rules and validate agreement, counts, and patch structure. Malformed, combined, unmappable, or cut-off sections produce explicit omissions, never successful empty diffs. Byte content must be preserved (base64 representation when UTF-8 decoding is not lossless); optional text is display-only. Do not normalize whitespace or CRLF in identity/content.

The diff milestone matches whole patch headers against C-quoted authoritative raw path pairs with `core.quotePath=true`; spaces need no ambiguous tokenization. Direct patches omit `--no-patch` and add `--patch --inter-hunk-context=0`, retaining metadata policy, immutable HEAD attribute source, and rename-limit fallback. Override `diff.suppressBlankEmpty=false` to keep context prefixes parseable; guard driver `xfuncname/funcname` settings because they can affect display headings. [Git patch context options](https://git-scm.com/docs/git-diff), [Git presentation configuration](https://git-scm.com/docs/git-config). Parser output retains whole validated hunks, optional UTF-8 text plus base64 bytes, and marker order/per-side flags. Separate type-change sections can share one raw file record. A truncated prefix withholds the last ambiguous hunk and reports unknown total bytes/omitted hunks. Each repository reserves one eighth of the bundle limit for parsed hunk content and another eighth for optional filesystem content; quota omissions are explicit, deterministic and partial. Non-UTF-8 text lines retain bytes without replacement decoding; NUL-containing forced-text hunks are unsupported. Untracked directory spellings ending in `/` are preserved as metadata while native locators strip that separator for no-follow checks.

Binary files retain metadata/OIDs, `binary: true`, null added/deleted counts, and no hunks; binary payload export is outside v0.1. Mode-only/type changes and pure renames can legitimately have zero hunks/counts. Tracked symlinks describe link-target text/mode, never referent content. Submodule gitlinks use a dedicated file kind, OIDs and dirty indicators, without fabricated text line counts. [Machine diff formats and flags](https://git-scm.com/docs/git-diff/2.43.0), [porcelain status](https://git-scm.com/docs/git-status).

Untracked metadata is separate in every collecting command, not counted in tracked file totals. Default means path/type/size and `contentPolicy: metadata-only`. `--include-untracked` adds eligible UTF-8 text/byte content as filesystem evidence (not committed Git hunks), with hash and capture interval. Git-ignored files stay excluded; additionally exclude `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, and the excluded directories/paths. Record policy/exclusion counts; this is not secret detection. Never follow untracked symlinks or read devices/FIFOs. Binary, oversized, unreadable, or unstable requested content gets metadata plus an omission reason; intentional secret/ignored exclusions define the requested scope, while other unmet content requests make it partial.

## 5. Repository discovery and path identity

Traverse from canonical root, root first, directory entries in byte-stable order, including nested repositories. Candidate `.git` directory or gitfile must be verified through `rev-parse` (inside worktree, toplevel, absolute gitdir, common dir, object format); a marker alone is insufficient. Do not discover an ancestor repository when root is only a subdirectory: root means scan downward; report that condition and require the repository root as input. Probe bare candidates and report `unsupported-bare` inventory entries, never pretend they have a worktree. A malformed marker or access failure is partial discovery. Empty workspace is complete with zero repositories.

Distinct linked worktrees have distinct IDs because each has its own HEAD/index/worktree. Deduplicate aliases by canonical toplevel plus per-worktree gitdir/filesystem identity, not common gitdir or remote URL. Gitfiles may refer to Git metadata outside root; permit Git to read that verified metadata but never traverse it for source repositories. Do not auto-enumerate worktrees outside the root. [Worktree organization](https://git-scm.com/docs/git-worktree).

Do not follow directory symlinks/junctions during discovery, even inside root; report policy-skipped aliases and avoid loops. Explicit root may itself be a symlink: resolve it once and use that canonical boundary. For tracked symlinks apply the file policy above. Track visited filesystem directories; an unexpected escape or inaccessible subtree is diagnosed. No recursive content reads through symlink components. Before worktree Git commands, inspect parent components of tracked paths: if a directory has become a symlink/junction, withhold worktree status/diffs for that repository and report unavailable coverage; keep immutable branch/staged facts. Do not let a whole-repository Git diff bypass this boundary check.

Submodule policy is parent gitlink metadata only, with `childContent: not-collected`; do not recursively scan initialized submodules or run update/init. Identify boundaries from the parent index's mode 160000 entries, not only `.gitmodules`. Report uninitialized and dirty states. Independently invoking a submodule as explicit root treats it as a normal repository. Intentional submodule child exclusion does not make the parent Git contract incomplete.

Internally use native absolute Windows drive/UNC paths and Node path APIs, not string slash surgery. Schema paths are repo/workspace-relative `/` strings, case and Unicode preserved. Use realpath/filesystem identity for case-insensitive alias deduplication; do not globally lowercase because Windows directories can be case-sensitive. Spaces/Thai/tabs and leading dashes are valid paths; render control characters safely. NUL cannot occur in filenames. Non-UTF-8 Unix filenames retain raw base64 metadata with null text path and `UNSUPPORTED_PATH_ENCODING` content coverage; never substitute lossy text into identity or subprocess arguments.

## 6. Evidence schema and deterministic identity

Publish JSON Schema `docs/evidence.schema.json`, generated from strict Zod schemas. English keys/enums only. Reject incompatible major schema versions; additive version changes must preserve existing meaning. Required bundle fields:

| Field | Contract |
| --- | --- |
| `schemaVersion`, `reportKind`, `collector` | Initial schema `1.0.0`; report kind `scan/status/diff/evidence`; collector name/version and actual Git version. Context renders an evidence bundle. |
| `collection`, `request` | Start/end ISO UTC timestamps; effective root locator, selection, scope, content policy, comparison settings, effective limits. Machine paths are locators, never identity inputs. |
| `discovery` | Policy boundary/exclusions, visited/candidate/selected counts, skipped entries and incomplete subtrees. Unknown remaining counts are null, never zero. |
| `repositories` | One outcome per selected/discovered failure: repository ID/key/path, worktree relationship, HEAD state/branch/OID, base input/source/OID, merge-base candidates/chosen OID, object format, index/working fingerprints, comparison outcomes, snapshot interval/attempts/consistency, capabilities and completeness. Unavailable values are null with reasons. |
| `evidence` | Validated discriminated union entries described below; only evidence from accepted snapshots. |
| `diagnostics` | Stable code, severity, stage, optional repository/path/comparison ID, safe message, bounded subprocess exit/stderr detail, retryability. No stack traces or unlimited source dumps by default. |
| `completeness` | Overall state/reasons, component/repository states, requested/collected/omitted counts and lower bounds/unknowns where needed; no inference from empty arrays. |

Every entry is `{id, kind, repositoryId, snapshotId, comparisonId, subject, data, source, confidence}`. `comparisonId` is null for inventory/status facts outside a comparison; source is a discriminated `git/filesystem/diff-parser` record with method/argument template, input OIDs or content hashes, path/side/range where applicable, and originating evidence IDs for parser-derived facts. Source argument templates use relative locators, with absolute invocation cwd held in repository locators. `confidence` is only `fact` in v0.1; it asserts the observed tool result, not behavior or impact.

Kinds and payloads: `repository` (identity/head/status summary), `comparison` (typed before/after endpoints and base provenance), `file-change` (status, both paths/modes/OIDs, text/binary/gitlink/symlink kind and nullable counts), `hunk` (parent file ID, ordinal, old/new ranges, ordered byte-preserving lines/markers), `untracked-file` (metadata and optional captured content), `conflict` (stage facts). Each kind has its own schema; generic unchecked `data` is prohibited. Validate references, range/count arithmetic, and per-file totals as well as shape.

Use SHA-256 over domain-separated canonical JSON: object keys sorted recursively, array order explicit, UTF-8 bytes, no incidental whitespace. Raw filename/content bytes use canonical base64. Define:

- `repositoryId = hash("repo-v1", logicalKey)` within this workspace. Default logical key is canonical root-relative repository path; distinct worktrees need distinct keys. Workspace relocation preserves IDs; repo relocation requires retaining an explicit configured key. IDs are workspace-local, not global clone identity. Never hash absolute paths, remote credentials, timestamps, or translations.
- `snapshotId = hash("snapshot-v1", repositoryId, objectFormat, accepted H/B/M, index stage/mode/OID/semantic-flag digest, relevant working byte/type/mode digests, status, effective comparison/config/attribute policy)`. Include null/unavailable tags explicitly. Only collection-affecting effective config enters this digest; exclude locale, locators, concurrency, interval, attempts, physical index stat cache, and tool display version.
- The existing v0.1 collector uses `comparisonId = hash("comparison-v1", snapshotId, scope, typed endpoints, effective diff policy)`. The accepted semantic snapshot carries repository identity and the captured inputs. Retain this conservative invalidation in evidence/context: unrelated status changes can change a branch comparison ID, even if its patch stays identical. IDs are observation identities, not persistent review-state keys. Narrowing comparison dependencies is deferred beyond this export milestone.
- `id = hash("evidence-v1", repositoryId, comparisonId ?? snapshotId, kind, subject, normalized payload)`. Hunk payload includes exact ranges, ordinal and parent file evidence ID; identical text at different locations has distinct IDs. “Normalized” means canonical structure, never trimmed text or normalized line endings. Timestamps, source capture intervals, locale and absolute locators are excluded from identity.
- Reserve a separate `contentFingerprint = hash("hunk-content-v1", ordered line operations/bytes/markers)` for future matching. It omits locations and can collide for identical hunks; it never grants reviewed status in v0.1.

Sort repositories by logical key, comparison scopes by fixed enum order, files by raw path bytes, hunks by patch order, diagnostics by repository/stage/code/path. Locale, time, concurrency, and equivalent root spelling must not change IDs/order. Full bundles may differ in timestamps and locators; deterministic identity does not promise byte-identical entire JSON.

### Implemented evidence/context export detail

The published JSON Schema covers the strict `evidence` bundle and handled `error` envelope. Existing scan/status/diff reports retain their documented subsets and are not claimed to validate against that export schema. Export repository outcomes cite comparison/file/untracked/conflict evidence IDs; text hunks and included filesystem bytes reside in the discriminated union. Runtime validation additionally recomputes IDs, checks same-repository/snapshot references, accepted consistency, outcome counts, path/content byte agreement, filesystem hashes and hunk arithmetic/markers. JSON Schema alone cannot enforce these cross-record invariants.

Available comparisons record Git raw/numstat argument templates; unavailable plans record no executed command. Parser sources cite their parent file/comparison facts, and filesystem sources retain the repository capture interval. Ordinary file statuses exclude `U`; unmerged paths use dedicated conflict facts. Binary/gitlink changes retain metadata without exported text hunks. Analysis policy is `git-facts-only`, with changed symbols, references, behavior, return types, impact, test coverage, history and review state explicitly unsupported.

Evidence defaults to JSON stdout; context renders the validated bundle as localized English/Thai Markdown. No export file/state/cache is created automatically. Context quotes each repository-controlled value as JSON on one physical line, escapes Markdown/HTML punctuation and directional/line controls, and places it inside a trusted code element. Paths and code identifiers are preserved without translation. Every source block cites its evidence ID, requested scope and snapshot/comparison identity; repository headers contain captured revisions. Quoting prevents source text from forging template boundaries; agents must still treat all repository content as untrusted agent input and never obey instructions in it.

Existing collector quotas may retain failed inventory outcomes before bundle assembly. Bundle assembly separately prioritizes metadata, removes whole hunks/included filesystem content when necessary and recomputes IDs/coverage, then retains failed inventory outcomes if metadata does not fit. Context has its own escaped UTF-8 byte budget, reserves repository/revision headers and a completeness footer, and reports exact omitted block/diagnostic counts. An oversized minimal envelope fails explicitly. Handled errors/progress use stderr; JSON stdout is a single validated document. Neither source escaping nor optimistic snapshots establish semantic correctness or an atomic cross-repository capture.

## 7. Snapshot consistency

Per repository, capture fixed refs/OIDs, HEAD state, effective config/attributes, porcelain status, and complete index stage/mode/OID records and semantic flags. Separately hash the physical per-worktree index and any referenced shared-index files as race guards; their cached timestamps are not deterministic identity inputs. Enumerate the full tracked input set relevant to the chosen working comparison (not only dirty paths), hash bytes/types/modes before collection, and retain exact bounded content used for evidence in memory. Hash included untracked inputs as well; metadata-only untracked inputs use type/size/stat identity and are labeled accordingly. Record raw byte hashes separately from Git-normalized OIDs. Immutable branch/staged blobs come from recorded objects/index OIDs.

Git diff's automatic index refresh can write despite `GIT_OPTIONAL_LOCKS=0`; disabling `diff.autoRefreshIndex` also disables the content checks that remove stat-only raw changes, so raw may disagree with numstat/patch. Git also freshens split-index timestamps during reads. Copy indexes/shared files to a disposable directory, let Git convert split copies to a full private index there, then run index readers against that copy with the original Git directory/configuration/refs/attributes/worktree. Diff formats pin automatic refresh on and split-index writes off. Only the collector supplies these trusted Git environment redirects; inherited overrides remain cleared. Preserve the real index/shared-index bytes and physical guard metadata, retain strict format joins and guard checks, and remove copies on success or failure. Temporary locators/stat caches are not observation identity inputs. See [Git's refresh implementation](https://github.com/git/git/blob/v2.53.0/builtin/diff.c), [diffcore's stat-content checks](https://github.com/git/git/blob/v2.53.0/diff.c), and [shared-index read freshening](https://github.com/git/git/blob/v2.53.0/read-cache.c).

Collect metadata, numstat, and patches with the same fixed OIDs/settings; compare their file sets/counts and parsed ranges/content. Re-read refs, index/status/config/attributes and hash relevant working inputs after collection; do not rely on size/mtime. Validate reread content against retained bytes and patch before accepting evidence. Recheck working status before/after even for a branch command, since reported status is mutable. If anything relevant differs, discard that attempt and retry the repository once (two attempts total); never mix successful stages across attempts. A second mismatch yields `SNAPSHOT_INCONSISTENT`, discards its content/comparison facts, and retains a failed outcome plus safe observed inventory/diagnostics.

Consistency is `verified-optimistic`, `inconsistent`, or `unverified` (limits/access failure). Only verified evidence can support a complete requested comparison. Hash/read limits cause partial/unavailable comparison coverage, not an assumed stable state. Repositories have independent intervals; the bundle is not a cross-repository transaction. Matching checks cannot rule out every ABA edit or malicious concurrent writer; document this limit and avoid “atomic snapshot” claims. No source cache/export on disk by default; stdout redirection is an explicit user export.

## 8. Limits, completeness, streams, and failures

Initial limits are engineering defaults to measure and adjust before release, not benchmark claims. All are finite, validated in config `limits`, recorded in output, and subject to CLI overrides listed in section 1:

| Limit key | Default |
| --- | --- |
| `maxDepth`, `maxDirectories`, `maxRepositories`, `concurrency` | 8 (root depth 0), 50,000, 128, 4; at most one Git process per repository |
| `gitTimeoutMs`, `repoTimeoutMs`, `maxMetadataBytes` | 30,000 per process, 120,000 per repository across retries, 16 MiB per metadata process |
| `maxFiles`, `maxHunks`, `maxFileBytes` | 10,000 tracked input paths per repository, 20,000 emitted hunks per repository, 2 MiB text content per file |
| `maxPatchBytes`, `maxBundleBytes` | 16 MiB raw patch per repository; 64 MiB serialized bundle |
| `maxSnapshotBytes`, `maxWorkspaceSnapshotBytes` | 256 MiB input hashing per repository attempt; 1 GiB total hashing per run including retries |

Rename limit is the fixed 1,000-candidate policy above. Reserve deterministic per-repository output/hash quotas in sorted order so concurrency cannot choose which evidence survives. Root configuration is capped at 1 MiB; diagnostic stderr at 16 KiB/process. Stop/terminate processes at byte/time bounds. Keep only fully parsed files/hunks; a truncated record is an omission, not a partial hunk. Prefer metadata before content; all count fields specify whether exact, lower-bound, or unknown. If total JSON exceeds budget, remove content units in stable order and recompute coverage/IDs; retain all repository outcomes and a bounded diagnostic summary. Reject configuration with budgets too small for the minimal envelope.

Completeness is relative to requested scope/capabilities: `complete` means discovery within declared policy and every requested component is verified; `partial` means useful requested results survive alongside omissions/failures; `failed` means no requested operation result is usable. Component states compose conservatively; a valid empty result is usable and can be complete. Zero repositories after successful discovery is complete. Config exclusions, metadata-only untracked defaults, binary metadata-only policy, and nonrecursive submodules are declared scope, not surprise truncation. Conflicts, unsupported requested content, read/parse failures, races, and exhausted traversal/budgets remain explicit partial/failed outcomes. Failed branch/all comparisons never render as clean.

| Exit | Meaning |
| --- | --- |
| 0 | Complete requested result, including no changes/zero repositories; help/version. |
| 1 | Operational failure or partial requested collection, unsupported required capability, output failure. |
| 2 | Invalid invocation/config/selection, including malformed JSON and unknown config version. |
| 130 | User interrupt; cancel children and report interrupted coverage if the output stream remains writable. |

JSON mode buffers/validates the final report and writes exactly one UTF-8 JSON document plus newline to stdout, including handled operational failures. Invocation/config errors use a small versioned `{schemaVersion, reportKind: "error", completeness: {state: "failed"}, diagnostics}` envelope in JSON mode, exit 2; an internal bundle-validation failure uses that envelope with `INTERNAL_CONTRACT_ERROR`, exit 1. Progress and bounded diagnostics go to stderr; no ANSI in JSON, no Git stdout leakage. `scan` JSON uses the common envelope with no evidence/comparisons; status/diff/evidence use their declared subsets. Human/Markdown output uses the same diagnostics/coverage and exit policy. Escape terminal controls, paths, headings, fences and source text; context labels repository content as untrusted data and never embeds executable agent instructions from it. JSON keys/IDs are English and locale-independent.

Handle per-repository errors without aborting successful peers. Do not print a speculative success before snapshot validation. Expected no-difference Git exits and `diff --no-index` exit 1 are adapter-level semantics, not collection errors. Broken pipes cannot carry a final JSON envelope; terminate cleanly without stack trace and exit 1. Process crash/kill or unwritable stdout cannot guarantee valid JSON; document this transport limitation.

## Consequences and alternatives

The contract gives explicit comparisons, reproducible provenance and conservative coverage with two runtime dependencies. It costs extra filesystem hashing, larger byte-preserving payloads, and occasional partial results on very large/racing/filter/sparse repositories. Git-version/config effects are observable, and workspace-local repository identity requires stable keys after repo moves. Defaults may be tuned from synthetic measurements without changing scope meanings.

Rejected alternatives: concatenating scope patches (wrong net result), base-tip comparison/branch-name guessing (wrong provenance), remote-URL identity (credentials/collisions/worktree collapse), timestamps or hunk text alone as IDs (unstable/ambiguous), native Git bindings or a monorepo (unneeded distribution complexity), running custom filters/project scripts (violates local read-only evidence boundaries), and temporary checkout/staging of user files (mutates scanned repositories). Optimistic read checks are chosen over repository locking or disk source caches; their non-atomic limit is explicit.

## Validation and future schema evolution

The [synthetic fixture matrix and packed-artifact gate](../implementation-plan.md#synthetic-git-fixture-matrix) are required before accepting the implementation. In particular, direct Git oracle comparisons, same-size content races, conflict omission, Windows shims/paths, deterministic identity, completeness, and script/network non-execution are release blockers when failing. This planning task reviews coverage only; it has not run future CLI tests.

v0.2 may add discriminated symbol/candidate/test/history kinds with exact content snapshot provenance and explicit confidence/capabilities; unsupported analysis must preserve v0.1 Git facts. v0.3 review acknowledgments remain separate state, with conservative fingerprint matching and ambiguous hunks becoming unseen. Neither version is implemented or provisioned by this decision.

Implementation follow-up: syntax/candidate/history extensions and the explicit local-review milestone are now implemented under their separate contracts. [Local review](../review-state.md) uses versioned context/content fingerprints and concrete snapshot citations, never v0.1 observation IDs alone. Evidence/context continue to exclude acknowledgment state; context generation never marks reviewed. The original planning boundary and evidence schemas remain intact.
