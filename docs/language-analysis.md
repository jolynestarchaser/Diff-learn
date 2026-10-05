# Syntax language analysis

`dr evidence --symbols` and `dr context --symbols` add bounded syntax observations for changed tracked TypeScript/TSX and JavaScript files. The flag is opt-in. Without it, commands still emit/render v0.1 `1.0.0` Git evidence. For the historical TS/TSX/JS profile, the bundle uses `1.1.0`, preserves the original Git evidence entries/IDs and adds `language-analysis` coverage and `symbol` observation entries. The original JSON Schema/validator remain available; [syntax-evidence.schema.json](syntax-evidence.schema.json) describes both versions and handled errors. `validateSyntaxBundle` also validates the unchanged v0.1 projection and cross-record syntax references. Package naming/version remain unpublished development metadata.

```sh
node dist/cli/main.js evidence --root . --base refs/heads/main --scope branch --symbols --json
node dist/cli/main.js evidence --root . --base HEAD --scope staged --symbols --json
node dist/cli/main.js context --root . --base HEAD --scope unstaged --symbols --lang th
node dist/cli/main.js evidence --root . --base refs/heads/main --scope all --symbols --json
```

These examples choose explicit existing local bases. `--symbols` is accepted only by evidence/context; scan/status/diff retain their v0.1 contracts. There is no LSP, type checker, semantic reference resolver or project configuration execution. Separate schema 1.2.0 [candidate/history opt-ins](candidate-analysis.md) keep their historical TS/TSX/JS profile; `--symbols` alone does not enable them.

Java extends syntax evidence through **1.3.0**, emitted when a Java endpoint is analyzed. [java-syntax-evidence.schema.json](java-syntax-evidence.schema.json) and `validateJavaSyntaxBundle` are separate from historical 1.0.0/1.1.0/1.2.0 schemas. The shared version dispatcher reads all four without loading native parsers. Java recognizes packages/imports, classes/interfaces/records/enums, annotation types/usages/elements, methods/constructors/compact constructors, fields (including multiple declarators), record components, enum constants and nested declarations. Initializers, anonymous classes and lambdas preserve unnamed boundaries. Local variables are not reported as fields. A changed type/member header can coexist with its annotations/record components; a body change does not imply a changed enclosing type header.

Exact parameter text is display evidence, not an overload key or resolved type. Duplicate overloads remain ambiguous even when one lies outside retained hunks. Unique method/constructor pairing additionally requires unchanged parameter display; changed signatures remain unmatched. Unicode byte offsets, CRLF, deleted before-only occurrences, errors, unsupported peers and bounded partial evidence use the same authoritative source/hunk checks. Pure renames and mode-only changes do not invent declarations without changed lines. Java syntax proves neither behavior nor semantic callers nor JUnit/test coverage. See [ADR 0002](adr/0002-java-and-export-ui.md).

## Runtime/grammar compatibility

| Component | Exact version | Compatibility/support |
| --- | --- | --- |
| `tree-sitter` | 0.21.1 | Node binding with Node-API prebuilds; runtime ABI 13–14 |
| `tree-sitter-typescript` | 0.23.2 | TypeScript and TSX grammars, ABI 14; optional native runtime peer `^0.21.0` |
| `tree-sitter-javascript` | 0.23.1 | JavaScript/JSX grammar, ABI 14; optional native runtime peer `^0.21.1` |
| `tree-sitter-java` | 0.23.5 | Java grammar, ABI 14; optional runtime peer `^0.21.1`; actually loaded and parsed on Node 24.20.0 Windows x64 |

Java compatibility was checked against the installed parser's `LANGUAGE_VERSION 14`, actual native loading and Unicode record/compact-constructor parsing with the existing runtime. Primary sources: [pinned Java package](https://github.com/tree-sitter/tree-sitter-java/blob/v0.23.5/package.json), [pinned parser](https://github.com/tree-sitter/tree-sitter-java/blob/v0.23.5/src/parser.c). Linux prebuilds are distributed, but native Linux/hosted execution of this change is pending; peer ranges alone are not execution evidence.

Primary sources: [runtime package/build configuration](https://github.com/tree-sitter/node-tree-sitter/blob/v0.21.1/package.json), [runtime compatibility constants/API](https://github.com/tree-sitter/node-tree-sitter/blob/v0.21.1/vendor/tree-sitter/lib/include/tree_sitter/api.h), [native parser usage](https://github.com/tree-sitter/node-tree-sitter/blob/v0.21.1/README.md), [TypeScript package/peer requirements](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.23.2/package.json), [JavaScript package/peer requirements](https://github.com/tree-sitter/tree-sitter-javascript/blob/v0.23.1/package.json). Installed primary parser sources declare `LANGUAGE_VERSION 14`; tests assert those constants and load all three grammars on the declared Node baseline. Newer grammar/runtime releases are not substituted: JavaScript 0.25.0 requires a different native peer range. These grammar versions do not establish complete support for a particular TypeScript compiler version or every future syntax proposal.

Selection uses extensions only: `.ts/.mts/.cts` → TypeScript, `.tsx` → TSX, `.js/.jsx/.mjs/.cjs` → JavaScript (including JSX syntax). Flow-specific syntax, Vue/Svelte/HTML embedded code, JSON, Python and other languages are unsupported. There is no filename/content heuristic or grammar fallback. Syntax errors/missing nodes produce diagnostics rather than claimed compiler acceptance. Only lossless UTF-8 without NUL is analyzed; BOM, CRLF, Unicode identifiers and astral characters retain byte identities. Native binding string offsets are converted from UTF-16 indices to UTF-8 byte ranges; lines are one-based, columns zero-based UTF-8 bytes, and byte/end positions are exclusive.

Node 24.20.0 on Windows has been verified with the shipped prebuilds and install scripts disabled. Platforms without a usable prebuild report `SYMBOL_RUNTIME_UNAVAILABLE`, retaining Git evidence. No compiler/download/build fallback is added. Linux/macOS native execution remains a separate verification gate. Upstream TypeScript 0.23.2's ambient export declaration is invalid under TypeScript 6; its opaque grammar handles are loaded through `createRequire` with a narrow type assertion, without disabling strict checks or using `skipLibCheck`.

## Exact source sides and snapshot consistency

| Scope | Before source | After source |
| --- | --- | --- |
| branch | Merge-base file blob | Captured HEAD file blob |
| staged | Captured HEAD blob (absent on an addition/unborn HEAD) | Captured index blob |
| unstaged | Captured index blob | Retained working filesystem bytes |
| all | Merge-base file blob | Retained working filesystem bytes |

Authoritative raw Git file records supply blob OIDs and both rename paths. Blob reads use `cat-file` by validated OID, never a mutable ref/path combination or pathspec. Index records and OIDs belong to the existing capture; no staged/unstaged/branch patch concatenation is used. Missing sides are explicit absent, empty content snapshots. Binary files, gitlinks, symlink/type-change sides, unsupported paths, oversized/unreadable sources and unavailable OIDs receive explicit analysis reasons while retaining Git metadata/hunks.

Working bytes are retained during the existing guarded before capture, not reread after acceptance. Analysis occurs before the after capture/recheck. A changed attempt discards its syntax observations together with its Git patch and retries once; repeated inconsistency exports no facts from those attempts. Blob/working hashes are SHA-256 and are separate from Git object IDs. Working-source hashes describe raw filesystem bytes; every retained patch line is checked against its corresponding source line. Git normalization/source disagreements (`SYMBOL_PATCH_SOURCE_MISMATCH`) withhold that side instead of analyzing text reconstructed from hunks or silently normalizing it. Existing optimistic/ABA and cross-repository limitations still apply.

## Mapping and matching

The `LanguageAnalyzer` interface declares supported grammar/capabilities and returns typed per-side snapshots, symbol occurrences, completeness and diagnostics. It recognizes class/function/method declarations, exported declarations, arrow/function-valued variables and fields, ordinary variable declarators, interfaces, type aliases, enums, namespaces and imports. Names come from syntactic name fields; anonymous/destructured/computed names are null rather than invented. Scope lists containing declaration kinds/names, not resolved lexical bindings. Other constructs are preserved as top-level program-region changes; no exhaustive language semantic model is claimed.

Removed lines map to before declarations; added lines map to after declarations. Context-only lines do not mark unchanged declarations. All innermost declarations overlapping a changed line are retained, so one hunk/line can cite multiple symbols. A class header change can cite the class; a method body change cites the method with its containing class scope. Changed lines outside supported declarations/imports cite the top-level program region. Whole-file deletion retains only before occurrences. Each observation has language, kind, nullable name, scope, side/range, exact declaration-content hash, source hash, ordinal and parent file/hunk evidence citations. Identical text at different ranges remains separate observation evidence. Pure file renames with no changed lines have source coverage but no invented changed declarations.

Pairing is only a candidate based on unique language/kind/name/containing-scope tuples across both parsed sources. Duplicate declarations/overloads, including ones outside retained hunks, make pairing ambiguous. Renamed symbols have independent unmatched before/after occurrences; text similarity is not used to manufacture a shared identity. Anonymous/import/top-level occurrences are not paired. A file rename comes only from Git metadata. Syntax-error regions and declarations containing errors are withheld; unaffected occurrences can remain with partial coverage. Parser timeout/node/observation limits and incomplete patches are explicit.

This milestone reports syntax/declaration changes only. It does not infer behavior, contracts, type compatibility or return types. Candidate matching is not proof of symbol continuity. Textual names/imports are not semantic references, and no semantic reference facts are emitted. Context labels these limits in English/Thai and uses the same untrusted-source quoting as v0.1.

## Bounds and completeness

Existing `maxFileBytes` bounds each source, and `maxPatchBytes` caps total analyzed source bytes per repository. The guarded working capture separately retains at most `maxPatchBytes` of supported source bytes; absent/over-budget content is unavailable. `maxHunks` also caps symbol observations per repository. Native parsing uses 250 ms per side; JS syntax traversal/mapping receives a further 250 ms per side and at most 100,000 syntax nodes. These effective limits are recorded in `languageAnalysis.limits`/capabilities alongside existing collection limits. Repository Git deadlines and snapshot budgets remain authoritative.

`languageAnalysis` records requested/analyzed/omitted file counts for retained tracked file metadata, analysis evidence IDs, state/reasons and original Git completeness. Unknown Git omissions remain unknown in Git completeness rather than being included in exact syntax counts. Top-level completeness/exit 1 includes unavailable or partial requested syntax coverage; successful Git facts remain independently usable. Unsupported languages explicitly have unavailable file-level analysis. Empty successful comparisons have complete empty analysis. Export limits drop whole syntax units, preserve Git data and report `SYMBOL_OUTPUT_LIMIT`; unavailable/omitted syntax is never a claim that no symbols changed. Runtime load failure also retains the Git result. The extended validator checks parent IDs, source/side hashes, ranges, hunk citations, candidate reciprocity and coverage counts. Full source is not exported as a new cache or declaration body.

Fixtures use real Git patches/blobs and synthetic classes, methods, functions, arrows, types/interfaces, imports, top-level/multiple declarations, deletions, modified renames, TSX/JS, Unicode byte ranges, syntax errors, overload ambiguity, unsupported language peers, limits, all scopes and working-tree mutation. Default v0.1 facts/schema and locale-independent extended identities are checked separately.
