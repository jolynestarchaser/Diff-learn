# v0.2 candidate discovery and history

`evidence` and `context` accept independent opt-ins `--references`, `--related-tests`, and `--history`. Each implies `--symbols` and emits schema **1.2.0**. No opt-in keeps v0.1 schema 1.0.0; `--symbols` alone keeps 1.1.0. Original Git and syntax facts/IDs remain intact. See `candidate-evidence.schema.json` for the structural schema and runtime validation for cross-record invariants.

```sh
dr evidence --root /path/to/synthetic-workspace --base baseline --scope staged --references --related-tests --history --json
dr context --root /path/to/synthetic-workspace --base baseline --scope all --references --related-tests --history --lang th
dr evidence --root . --base HEAD --scope staged --history --max-history 5 --json
```

No repository scripts, tests, hooks, preprocessors or LSP run. No additional npm dependencies or grammars are added. Native TS/TSX/JS capability constraints still apply. Reference search needs external `rg` on PATH; Git-only/default syntax commands do not. Verification uses ripgrep 15.2.0 on Windows. Compatible installations must support the documented flags and JSON output; an unavailable executable or unsupported flag produces observable partial output, not an empty successful result. Hosted CI/platform execution remains unverified.

## Exact bounded corpus

The corpus contains selected repositories' tracked, regular, lossless UTF-8 files without NUL. Each repository uses its requested comparison's **after** endpoint: branch uses pinned HEAD blobs, staged uses index stage-zero blobs, unstaged/all use captured working bytes. Before-side/deleted symbols search this same after corpus; that does not establish a present declaration or caller. Untracked content is not searched, even with `--include-untracked`; that flag continues to govern separate filesystem evidence. Binary/non-UTF-8 files, symlinks, gitlinks, submodule content, Git internals, dependency/generated directories and configured excludes are outside the corpus.

Capture verifies the original repository snapshot identity, reads bounded content, and rechecks its optimistic guard. Changed snapshots withhold that repository's corpus and retain its earlier Git/syntax facts with diagnostics. Working contents are retained during capture, never substituted from later rereads. Blob content is read by full immutable OID. Repositories/worktrees retain their distinct identities. Ancestor repositories do not re-search nested selected repositories. Configured `excludeDirectories` apply by literal component; `excludePaths` apply to literal workspace-relative prefixes. No symlink traversal occurs. Tracked inventories, rather than recursive filesystem discovery, define the bounds; the existing Git index limits also apply to immutable corpus collection.

The corpus is materialized in a disposable, generated flat temporary directory with numbered regular files and no user-controlled names. `rg` traverses only that directory; `.gitignore`, `.ignore`, external config and real-workspace symlinks cannot change it. Matches map back to original repository/path bytes. Temporary directories are removed after collection. Corpus manifests export paths, origin, endpoint, blob OID (or null for filesystem), byte length, SHA-256, comparison/snapshot IDs and deterministic corpus IDs; full file bodies are not exported. The corpus ID hashes its retained content manifest, not the temporary location or time. Multi-repository verification is optimistic per repository, not an atomic workspace transaction.

## Reference search rules

For each retained changed declaration with a supported identifier name, search its exact name as a **case-sensitive fixed substring**. Imports, anonymous declarations and top-level regions do not receive identifier queries. Before/after occurrences each retain their own evidence IDs; duplicate names can reuse a search execution while receiving separate query records. Names are not resolved to semantic identities. The query record lists all retained changed symbols sharing that name, including other repositories. An unqualified method/private name is still only a substring candidate.

Argument arrays with `shell: false` use:

```text
rg --json --fixed-strings --case-sensitive --no-config --no-ignore --hidden
   --no-follow --no-mmap --no-pre --no-search-zip --encoding none
   --color never --threads 1 --sort path --max-count (maxResults + 1)
   -e <literal identifier> -- .
```

No regex expansion, word boundary, case folding, import resolution or semantic filtering is implied. Longer identifiers, declarations, comments and strings can match. Byte ranges are checked against captured content. Line numbers are one-based; byte offsets and columns are zero-based and end-exclusive. A candidate includes the query, parent query/symbol IDs, exact content snapshot, range, cross-repository flag and `confidence: candidate`. `fact` confidence on query outcomes means an observed search outcome, not a confirmed reference. Cross-repository text matches do not confirm callers or dependencies.

The structured JSON stream distinguishes `matches`, `no-matches`, `missing-rg`, `execution-error`, and `truncated`. No matches means none in the **retained corpus**, never none in the project or language graph. Missing executable, invalid JSON/ranges, timeout, abnormal exit, count/output bounds and source omissions remain diagnosed. The per-file `--max-count` is an execution bound; the application separately enforces a global per-symbol occurrence limit. A sentinel or partial stream marks truncation with unknown total omissions; no invented total is reported. Complete retained records may survive truncation, never partial JSON records. Stderr does not enter JSON stdout.

Primary references: [ripgrep guide: fixed strings, exclusions and configuration](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md), [ripgrep flag definitions: JSON, byte encoding, count and traversal controls](https://github.com/BurntSushi/ripgrep/blob/master/crates/core/flags/defs.rs).

## Potential test heuristics

A file is test-like if its path contains `__tests__`, `test/tests`, `spec/specs`, or its basename has `.test.<extension>` / `.spec.<extension>`. Supported TS/TSX/JS syntax can also identify a call whose callee is literally `test`, `it`, `describe` or `suite`, optionally `.only`/`.skip`. This is a syntactic hint; shadowed functions and non-test uses are possible. Unsupported languages may still supply filename/text candidates. Syntax errors/time/node limits withhold structural hints and leave filename/text hints with diagnostics.

A test-like file relates to a changed named declaration when one or more rules match:

- its file stem equals the source file stem in the same repository;
- its file stem equals the queried symbol name;
- retained fixed-string matches contain the queried name;
- a parsed static relative `import` string names the same repository's source path, after POSIX normalization, removing TS/JS extensions or permitting an `index` suffix.

Import aliases can supply useful structural candidates without assuming calls. No package alias, re-export, runtime resolver, dynamic import, CommonJS resolver or dependency graph is inferred. Escaped import strings are not guessed. Each result lists all matching rules, supporting import syntax ranges when available, content hash/snapshot provenance, and `testExecution: not-run`. Filename-only candidates have a null source range because filenames have no code range. Search limits and unavailable syntax can omit potential tests. Neither `no-candidates` nor filename/text absence proves a missing test or coverage gap; no test results, impact or coverage are inferred.

## Bounded history semantics

One history query per retained changed file uses its original and destination paths (deduplicated) and the repository's pinned **HEAD commit**, independently of scope. It does not include uncommitted changes. Unborn HEAD produces an explicit empty `unborn` result. No branch/ref guessing or fetching occurs. The query is:

```text
git --literal-pathspecs -c log.follow=false -c log.showRoot=true
    log --no-ext-diff --no-textconv --no-patch --no-color
    --no-abbrev-commit --no-use-mailmap
    --no-decorate --no-show-signature --no-notes --no-renames --topo-order
    --max-count=(maxHistory + 1) --format=%H%x00%P -z
    --end-of-options <full captured HEAD OID> -- <literal paths...>
```

The existing Git runner disables replacement objects, lazy fetch, external filters/protocols and uses argument arrays. `log.follow=false` overrides implicit following from user/repository config; root visibility, full IDs, no-color, no-mailmap and no-signature behavior are pinned too. The normal Git path-limited history simplification applies; this is reachable, path-filtered history in topological order, not first-parent, `--follow`, `-S`/`-G` pickaxe or symbol history. Both rename paths are explicitly queried, but lineage is not reconstructed. Returned records contain full commit/parent IDs, not commit messages. Messages are not consulted and never serve as proof of runtime behavior. The N+1 record discloses a truncated result; shallow repositories disclose their history boundary. Output/time/command failures remain observable. The exact arguments and query semantics are exported.

Primary references: [Git log documentation: revision/path separation, formatting, topological order, max count and history simplification](https://git-scm.com/docs/git-log), [Git configuration documentation: implicit log.follow and presentation defaults](https://git-scm.com/docs/git-config).

## Bounds and completeness

Default CLI limits: `--max-symbols 32` (1..256), `--max-results 50` (1..1000), `--max-history 20` (1..200). `maxSymbols` also bounds history file queries. These flags require a candidate/history opt-in. Limits count evidence occurrences, so before/after and duplicate-name symbols consume separate query slots. Search execution can be reused for identical names.

The workspace corpus is limited to `min(maxFiles, 500)` files and `maxPatchBytes` aggregate content (default 16 MiB); each file obeys `maxFileBytes`. Working capture retention also obeys the existing per-repository `maxPatchBytes`, so earlier tracked files outside the searchable set can consume retention space; that omission is reported. Existing repository/workspace hashing and metadata budgets apply. Each rg query retains at most `min(maxMetadataBytes, 4 MiB)` stdout and runs at most `min(gitTimeoutMs, 10 seconds)`. The whole extension is bounded by `min(repoTimeoutMs, 120 seconds)`. Structural hints use the same 100,000-node / 250 ms parse bounds, with a separate 250 ms traversal bound. Queries/results/files omitted at a limit are explicit.

`discoveryAnalysis` reports corpus coverage and separate reference/test/history states, requests, queries collected/omitted, diagnostics, limits and evidence IDs, preserving original syntax/Git completeness separately. No requested component is represented as unsupported success. Empty complete queries can legitimately have zero results. Unavailable input is disclosed even when other repositories/components succeed. If overall `maxBundleBytes` is exceeded, whole new discovery/history evidence is omitted with `DISCOVERY_OUTPUT_LIMIT`, preserving Git/syntax facts. Minimal envelopes can still fail with `BUNDLE_LIMIT`.

JSON remains one English-keyed document; diagnostics go to stderr. Existing exits remain 0 complete, 1 partial/operational failure, 2 invalid inputs, 130 interruption. Context cites each evidence ID/scope/revisions and quotes source-controlled strings. Paths, queries, source syntax and history metadata are untrusted agent input. Codex/Claude must describe these records as candidates, cite them, and retain the not-run/no-coverage/semantic-unavailable labels. There is no automated transport, test execution, LSP, contract inference or new grammar support.
