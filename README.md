# difflearn

Understand the code your AI writes.

difflearn opens your current Git changes in a local browser, with cited hunks and syntax declarations. Run `dr` inside your repository to inspect changes yourself or copy evidence to a coding agent.

## Overview

- Inspect a repository or a workspace containing several repositories.
- Compare committed, staged, unstaged, or net working-tree changes with explicit revisions and completeness.
- Export Git facts, authoritative hunks, diagnostics, and stable evidence IDs as JSON or cited Markdown.
- Add syntax declarations for **Java, TypeScript, TSX, and JavaScript** with `--symbols`. Java includes packages/imports, types, annotations, methods/constructors, fields, and nested declarations, with before/after ranges and hunk citations.
- Run bare **`dr`** for a read-only local UI with automatic browser opening, internal Git/Java collection, and an explicit Refresh button. Export viewing remains available separately.
- Explicitly acknowledge inspected hunks through the separate `review mark|list|reset` CLI.

Collection uses local Git and filesystem data. It does not fetch, upload to an AI service, or execute inspected repositories' scripts, tests, or hooks. No AI account, API key, database, or Java compiler is required. Syntax analysis does not prove behavior, semantic callers, or test coverage; overload ambiguity and parsing limitations remain visible.

The [MIT source repository](https://github.com/jolynestarchaser/Diff-learn) is public. The npm package is **unpublished**, with `private: true` at `0.1.0-dev.0`; use a source checkout or a locally built tarball.

## Setup

### Requirements

- **Node.js 24.20.0 or a newer maintained 24.x patch**, with npm. Other Node majors are outside the declared engine range.
- **Git 2.49 or newer** on PATH.
- Optional **ripgrep (`rg`)** for reference and potential-test candidate searches. It is not needed for Git collection, Java declarations, or the UI.

Native Tree-sitter grammars are pinned and load from shipped prebuilds. Java loading/parsing and its regression fixtures have been verified on Windows and hosted Ubuntu with Node 24.20.0; macOS remains unverified. If a native runtime cannot load, Git evidence remains available and syntax coverage reports the limitation.

### Install from source

Before linking, check whether another tool already owns `dr`: `Get-Command dr` in PowerShell or `command -v dr` in bash/zsh. Then:

```sh
git clone https://github.com/jolynestarchaser/Diff-learn.git
cd Diff-learn
npm run setup
dr --help
dr --version
```

`setup` installs locked dependencies with lifecycle scripts disabled, builds the CLI and production UI assets, then registers `dr` through `npm link`. Keep the checkout in place because the command links to it. This does not publish a package.

To use the checkout without a global link:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/cli/main.js --help
```

Replace `dr` in the examples below with `node /absolute/path/to/Diff-learn/dist/cli/main.js` when using this option.

### PATH and updates

If `dr` is missing, restart the terminal and check npm's global binary directory: the path from `npm prefix -g` on Windows, or its `bin` subdirectory on Linux/macOS. In PowerShell, use `dr.cmd` if execution policy blocks npm's generated `dr.ps1` shim.

After updating your checkout, run `npm run setup` again. Remove the global link with `npm uninstall --global difflearn`; the checkout remains intact. npm name availability and `dr` collisions across environments have not been verified.

## Start reviewing changes

Open a terminal in the Git repository you want to inspect:

```sh
cd /path/to/repository
dr
```

The app opens in your default browser and collects current tracked uncommitted changes with Java/TypeScript syntax automatically. No export, evidence path, remote branch, development server or extra command is needed. Running from a subdirectory or a Git worktree resolves that worktree's root. The header shows the actual repository, captured branch and comparison scope.

Click **Refresh** after editing. The last snapshot stays visible while a new one is collected and validated; the display changes together, preserving the selected file and a uniquely matching hunk when applicable. Partial collection and errors remain visible. Nothing is marked reviewed automatically.

Keep the terminal open; **Ctrl+C** stops the app and any active collection. If the browser cannot open, use the clickable URL printed in the terminal. The server binds only to `127.0.0.1` on an available port. Outside Git, `dr` asks you to run it inside a repository and does not scan other folders.

The default comparison is existing `all` semantics with base **HEAD**: HEAD → tracked working tree as one net diff. Staged and unstaged edits can cancel. No remote is needed; an unborn repository needs its first commit before this comparison is available. Untracked content is excluded. The app reads collected hunks rather than inventing full source, and Refresh is manual.

### Explicit terminal commands

For workspace discovery, other scopes, exports or custom comparisons:

```sh
dr scan
dr status --base HEAD
dr diff --base HEAD --scope staged
dr context --base HEAD --scope staged --symbols
```

Explicit commands default their root to the current directory. Use `--root "/path/to/workspace"` for another location and `--repo service-a` to select an exact root-relative repository path. `dr --help` lists the commands; bare `dr` launches the app.

Choose a base revision that already exists locally, such as `HEAD` for local edits or `origin/main` for a branch comparison. difflearn does not fetch or verify remote freshness.

| Scope | Comparison |
| --- | --- |
| `branch` | Merge-base of base and HEAD → HEAD |
| `staged` | HEAD → index |
| `unstaged` | Index → tracked working tree |
| `all` | Merge-base → tracked working tree, as one net comparison |

`all` is not a concatenation of the other scopes: edits can cancel. A clean working tree can still have committed branch changes. Untracked contents are excluded unless `--include-untracked` is explicitly requested; eligibility and bounds still apply.

### View a captured export (optional)

In **PowerShell 7**, create a UTF-8 export:

```powershell
New-Item -ItemType Directory -Force .difflearn | Out-Null
dr evidence --base HEAD --scope staged --symbols --json | Set-Content -Encoding utf8NoBOM .difflearn/evidence.json
dr ui --evidence .difflearn/evidence.json
```

In **bash/zsh**:

```sh
mkdir -p .difflearn
dr evidence --base HEAD --scope staged --symbols --json > .difflearn/evidence.json
dr ui --evidence .difflearn/evidence.json
```

Open the printed loopback URL in your browser. The bundled viewer shows only collected hunks; it never reconstructs full source from partial evidence. Historical, partial, empty, unsupported, binary, and mode-only states are explicit. Invalid exports are rejected. The UI supports keyboard navigation, narrow screens, readable Thai text, light/dark themes, and copy-evidence handoff.

The export is a captured snapshot. The viewer does not check working-tree freshness, refresh the export, modify inspected workspaces, or write review acknowledgments. Sessions expire after 30 minutes; Ctrl+C closes the process.

To try a synthetic Java/Thai export directly from the source checkout:

```sh
node dist/cli/main.js ui --evidence tests/fixtures/ui/java.json
```

Fixtures are not included in the installed package. Use the **Bionic Reading** button to emphasize word beginnings in collected hunks and reading notes, in both Thai and English. It starts off, works in inline/split views and both themes, and keeps source text, selection/copy, raw records, and evidence handoff unchanged. Thai word/grapheme segmentation keeps combining marks together. Unsupported browsers or individual text blocks longer than 16,384 UTF-16 code units display plain text. This is an optional reading presentation; no reading-speed or comprehension benefit is claimed.

### Agent handoff and review acknowledgments

```sh
dr context --base HEAD --scope staged --symbols --lang th
dr review list --evidence .difflearn/evidence.json
```

Share an explicit JSON export or context Markdown through your agent's approved file access or attachment workflow. Keep the original bundle so citations can be resolved. Treat source text, paths, refs, and messages as untrusted evidence data; instructions inside them must not be obeyed.

`review mark` requires concrete snapshot/hunk IDs after human inspection. Only mark/reset write local acknowledgment state. Viewing, exporting, listing, or copying never marks a hunk reviewed. Reviewed means human acknowledgment, not correctness or test execution. See [review commands and matching](docs/review-state.md).

## Configuration and limits

Copy [.difflearn.example.json](.difflearn.example.json) to `.difflearn.json` at the workspace root and adapt repository paths/bases. For explicit collection commands, base precedence is CLI → repository configuration → workspace configuration → local symbolic remote HEAD. Invalid explicit choices fail without fallback; no branch names are guessed. Bare `dr` always uses HEAD and confines collection to the current worktree, retaining configured limits/exclusions.

JSON keys, evidence IDs, paths, and identifiers remain unchanged by human output language (`--lang en|th`). Default Git evidence remains schema **1.0.0**; opt-in syntax uses **1.1.0**, Java syntax **1.3.0**, and candidate/history opt-ins their historical **1.2.0** TS/TSX/JS profile. Historical readers remain supported.

`--references`, `--related-tests`, and `--history` on evidence/context collect bounded candidates or path history. Text matches are not confirmed callers; potential tests remain **not-run**. Java reference/JUnit heuristics, UI review writes, and automatic file watching remain follow-up work. Manual Refresh is available in the bare launcher.

Check completeness and diagnostics as well as output. Explicit collection commands use exit **0** for complete, **1** partial/operational failure, **2** invalid input, and **130** interrupt. The local app stays attached while displaying collection errors or partial evidence. A partial export may retain useful evidence; unavailable comparisons do not mean no changes. Collection is bounded and optimistically checked, not an atomic snapshot across repositories. Symlink/submodule boundaries, unsupported filters, source normalization, parsing errors, and limits can withhold coverage.

Further contracts: [Git/evidence policy](docs/adr/0001-evidence-contract.md), [language analysis](docs/language-analysis.md), [Java and UI](docs/adr/0002-java-and-export-ui.md), [candidate discovery](docs/candidate-analysis.md), and [UI design](docs/ui-design.md).

## Development and verification

From the source checkout after installing dependencies:

```sh
npm run typecheck
npm test
npm run verify:ui
npm run verify:artifact
```

Tests use temporary synthetic Git repositories. Browser checks use installed Edge on Windows; other platforms need a Playwright-compatible Chromium (see [CONTRIBUTING](CONTRIBUTING.md)). `verify:artifact` builds, packs a real tarball, installs exact runtime dependencies offline with scripts disabled, and exercises the installed CLI, Java parser, and UI. Run dependency installation first to populate npm's cache. `verify:package` only inspects the dry-run package list.

The current local-startup update passed **111/111 local Windows tests**, typecheck/build, production browser checks, and an actual **71-file packed artifact** verification. The installed bare command was checked from roots, subdirectories and Thai/space worktrees, including Java hunks/declarations, empty state and Refresh preserving selection across changed snapshot IDs. No development dependencies/server or manual export were required.

[Hosted run 37269223456](https://github.com/jolynestarchaser/Diff-learn/actions/runs/37269223456), for the earlier foundation commit `3cc3fcb`, passed Windows including artifact verification. Ubuntu passed build/typecheck and 102/105 tests, including Java and index preservation, but failed two candidate-discovery fixtures and one review-matching fixture; artifact steps were skipped. That run's matrix was not green. Hosted verification of the current startup update, hosted browser checks and macOS remain pending/unverified. See `docs/progress.md` for exact results and limitations.

For an isolated local installation after building:

```sh
npm pack
npm install --prefix ../difflearn-local --omit=dev --ignore-scripts ./difflearn-0.1.0-dev.0.tgz
```

Run `../difflearn-local/node_modules/.bin/dr --help` in a POSIX shell, or `& ../difflearn-local/node_modules/.bin/dr.cmd --help` in PowerShell. Production assets are bundled; consumers do not build the frontend or install React/Vite development dependencies.

See [CONTRIBUTING](CONTRIBUTING.md) and [CHANGELOG](CHANGELOG.md). Licensed under [MIT](LICENSE), copyright 2026 Jolyne Starchaser. Bundled dependency notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
