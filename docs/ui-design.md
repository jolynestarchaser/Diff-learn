# Difflearn Review Workspace

This read-only vertical slice follows the current user brief. Use cases are approved by that brief's instruction to continue through design and integration without phase confirmations. The subsequent startup brief adds bare `dr` and explicit manual Refresh; review writes and automatic watching remain deferred. Export viewing retains its immutable-session policy.

Later scope clarification: bilingual language switching and Bionic Reading for Thai and English belong to a follow-up milestone, not the Java/UI acceptance scope. The selector implemented before that clarification is preserved as existing work; no further language/reading work is started here. Thai/Unicode evidence must remain readable and lossless in the core viewer. See the [deferred backlog](progress.md).

Subsequent authorization on 5 October 2026 starts the Bionic Reading follow-up after the Java/UI milestone was verified, committed and pushed. The earlier scope clarification remains the foundation milestone's boundary.

Primary user: a developer checking an exported snapshot across many repositories, then copying cited evidence into a terminal agent. Primary task: read authoritative changed lines together with their declarations, provenance and limitations. The focal point is the hunk text; navigation and inspection use quieter surfaces. All input/source is untrusted data.

## Layout decision and tokens

The current shadcn/ui brief updates controls and surfaces incrementally. Existing language/reading presentation remains preserved code; expanding bilingual switching or Bionic Reading remains a later milestone.

| Existing interaction | shadcn/ui implementation | Preserved contract |
| --- | --- | --- |
| Refresh, navigation, selection, copy | Button | Existing actions, disabled/loading states and evidence IDs |
| Review modes and inline/split view | Tabs | Atomic accepted comparison; custom hunk rendering |
| Paths, comparison ref, existing preferences, handoff | Input, Native Select, Label, Textarea | Thai/native keyboard entry and read-only handoff |
| Explorer/inspector desktop surfaces | Card with flat workbench styling | Existing widths, palette and landmarks |
| Responsive panels | Sheet | One mounted panel, Escape, focus restoration and selected file |
| Original record/provenance | Dialog | Original JSON, untrusted content as text, bounded scrolling |
| Evidence actions | Dropdown Menu | Copy or inspect only; no review acknowledgments |
| Supplemental control explanation | Tooltip | Keyboard access without changing source or actions |

Components are owned source from the official new-york registry, with Native Select from new-york-v4. Tailwind 4's Vite plugin compiles utilities into bundled production assets. The existing CSS palette maps to shadcn theme variables; no network styles/fonts or runtime component downloads. The authoritative hunk/line renderer stays custom, with its original characters, coordinates, uncollected gaps and provenance. Radix-generated scroll-lock styles receive the session CSP nonce; arbitrary inline styles and eval remain disallowed. The existing [workspace wireframe](ux-flows/wireframes/workspace.html) includes the record/sheet surfaces.

Compare [three-column wireframe](ux-flows/wireframes/workspace.html) with [wide-diff/bottom-inspector wireframe](ux-flows/wireframes/wide.html). Choose the three-column workspace at desktop widths: declaration ranges and coverage stay visible while reading. The wide alternative gives more code width but requires vertical movement to compare provenance. Both use synthetic content and are reusable static HTML, not collector integration. The working React UI implements the chosen layout.

At 1440/1280px: 248px explorer, flexible diff, 328px inspector. At 1024px: inspector opens in an explicit shadcn Sheet. At 768/375px: explorer and inspector open as sheets; reading remains central. Each panel has only one mounted copy. Code scrolls inside its own region; the page never forces horizontal scrolling. Controls remain reachable with text zoom.

| Token | Dark | Light | Purpose |
| --- | --- | --- | --- |
| Background | `#171b22` | `#f4f6f8` | Workspace |
| Surface | `#202630` | `#ffffff` | Panels |
| Text | `#e5ebf2` | `#19232f` | Main content |
| Muted | `#b3bfce` | `#46576a` | Secondary text |
| Border | `#4c596b` | `#bac6d2` | Functional separators |
| Accent/focus | `#78d8e3` | `#086b78` | Selection/focus |
| Addition | `#c1e8cb` / `#203b2b` | `#185332` / `#e0f2e5` | Added lines |
| Removal | `#f5c2ca` / `#42282e` | `#862738` / `#fbe6ea` | Removed lines |

Use system Segoe UI/Tahoma/system-ui for labels and Thai; Cascadia Code/Consolas/Tahoma/monospace for code and IDs. No network fonts. Body 16px/1.6, compact labels/code 14px/1.65, headings 20px. Spacing: 4/8/12/16/24px. Corners: 4px controls, no decorative panel shadows/gradients/glow. Focus: 3px accent with 2px offset. Status always has text, not color alone. Reduced motion is respected; no unsolicited animation.

The local ui-ux-pro-max search matched a coding dark palette and readable typography, but returned a FAQ landing layout even after a narrower retry. That layout was rejected as unrelated. Layout/tokens follow this workbench brief; accessibility uses the skill's verified general guidelines. frontend-design and no-ai-design-slop preserve this direction, avoid nested status cards and keep metadata subordinate to code.

## Components and honest states

- Header: captured export/schema/time, requested scope/base, separate Git/syntax/candidate coverage, read-only/freshness labels, Thai/English and light/dark controls.
- Explorer: named repository buttons/outcomes; paginated file facts with original paths/statuses, labeled path/change filters, retained failed repositories.
- Viewer: file modes/encoding/patch coverage; original hunk ranges and ordered text with old/new coordinates and final-newline/CR metadata. Inline/split controls and previous/next hunk navigation. Uncollected ranges are explicit.
- Inspector: selected record ID, Java/other declarations with side/range/matching/signature, exact provenance, diagnostics and coverage. Historical candidate records keep candidate/not-run wording. No test or semantic conclusions are invented.
- Handoff: bounded copy of selected evidence and IDs; visible success/error and selectable-text fallback. Opening, selecting or copying never writes review state.

Empty complete exports say no changes in the requested comparison. Failed/partial exports preserve their reasons and retained data. Unsupported syntax says unavailable separately from Git success. Binary/gitlink/mode-only files show metadata without text. Historical exports are labeled by schema and captured time; working-tree freshness is never claimed. Invalid exports are rejected by the CLI, and browser/session/API failures have actionable error states. No review write or automatic freshness control exists.

## Simple local startup

Bare `dr` resolves the current worktree, serves bundled assets immediately and opens the default browser. A persistent path/branch/scope strip sits above the existing workbench. Its explicit Refresh button recollects guarded `all` evidence against HEAD with syntax, without a remote or export. While loading, the actual location and comparison are visible; during Refresh, the old view remains. Generation-pinned repository, file, hunk and inspector pages are prepared before one render replaces the view. Match selection by retained path and unique unchanged hunk content; ambiguous selections fall back rather than invent continuity. Collection/validation errors retain the previous snapshot and offer Refresh. Complete zero changes, partial collection and unborn HEAD are separate states. See [startup wireframe](ux-flows/wireframes/startup.html) and [approved flows](ux-flows/UX-FLOWS.md).

The browser opener receives only the server's loopback URL, uses no shell or repository commands, and runs once. Failure prints that URL while the server stays attached to the terminal. Ctrl+C aborts collection and closes the listener. Local sessions last until terminal shutdown; explicit exported sessions keep their 30-minute bound. Existing language and Bionic controls are preserved without adding follow-up work.

Keyboard: skip links to viewer/inspector, shadcn buttons and native selects/details, logical tab order, visible focus, Enter/Space activation, explicit previous/next hunk and responsive sheets. Tabs use arrow keys; review mode activation requires Enter/Space so moving focus alone does not start expensive collection. Dialogs/sheets manage modal focus, Escape and trigger restoration through Radix. New file selection instead focuses its heading on narrow screens. Copy failure never steals evidence selection. Screen reader status uses a polite live region. Source values are plain text even when they contain HTML.

See [use cases and navigation](ux-flows/UX-FLOWS.md). Actual browser verification and screenshot references are recorded in `docs/progress.md` after checks finish.

## Local commit review

Keep the existing workbench, type and color tokens. Two shadcn tabs sit below the persistent repository strip: **Uncommitted changes** / **Unpushed commits**. Only the latter exposes a bounded, scrollable commit list above the explorer/hunks/inspector. Each row shows abbreviated SHA, untrusted subject as plain text, author/date and parent-comparison policy. Keyboard Enter/Space selects a row. On narrow screens row metadata stacks without page overflow.

The comparison panel shows the full captured upstream/chosen-ref ID, HEAD, ahead/behind/divergence and the local-only freshness limitation. Missing/no upstream and detached HEAD offer a native select populated only from local refs. A chosen ref stays labelled as chosen. Aggregate is a separate action: unique merge base → HEAD net diff. No/multiple merge bases disable that action while valid commit rows remain available. First-parent merge and empty-tree root labels display actual parent IDs; shallow missing parents explicitly withhold the view. Empty outgoing ranges clear historical hunks, rather than leaving old content beneath an empty label.

Mode/commit changes use the same authenticated loopback session and atomic projection preparation as Refresh. The accepted comparison metadata and files/hunks/inspector replace together; in-flight changes keep the previous labels and evidence until validation finishes. Refresh recaptures local refs; selecting an existing row uses captured IDs. Historical source always comes from raw-diff blob IDs. Copy handoff carries commit selection/comparison IDs and unverified remote freshness. No automatic fetch, source synthesis, review write or repository mutation is introduced.

## Reading preference (existing behavior)

Keep the existing review workbench and tokens. The preserved pressed-state shadcn Button remains in the preferences group: `[Bionic Reading off/on] [Language] [Theme]`. It is off on each new session; keyboard Space/Enter toggles it and mobile controls wrap. No settings file, storage, network dependency or collector option is needed. This describes already implemented behavior, not authorization to expand the deferred milestone.

Emphasize the first half of each word's grapheme clusters in source lines and explanatory notes, using the existing 700 weight. Use Thai word segmentation for mixed Thai/English text, preserving all original characters and whitespace; attach a Thai leading vowel to the following consonant at the emphasis boundary. Use presentation spans rather than semantic emphasis or HTML parsing. Source remains selectable as the same text, and the inspector's raw JSON and copy handoff use untouched original records. Keep IDs, hashes, paths, coordinates and controls plain.

Both inline/split layouts and themes use the same preference, independently of UI language. Without Intl.Segmenter, or for a text block exceeding 16,384 UTF-16 code units, show plain text. Browser dictionaries/font shaping may vary; this is a visual preference, not a proven reading-speed or comprehension aid. All existing partial/historical/security policies remain in force.
