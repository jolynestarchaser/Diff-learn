# Difflearn Review Workspace

This read-only vertical slice follows the current user brief. Use cases are approved by that brief's instruction to continue through design and integration without phase confirmations. The supplied plan's explicit review writes and live refresh are deferred.

Later scope clarification: bilingual language switching and Bionic Reading for Thai and English belong to a follow-up milestone, not the Java/UI acceptance scope. The selector implemented before that clarification is preserved as existing work; no further language/reading work is started here. Thai/Unicode evidence must remain readable and lossless in the core viewer. See the [deferred backlog](progress.md).

Subsequent authorization on 5 October 2026 starts the Bionic Reading follow-up after the Java/UI milestone was verified, committed and pushed. The earlier scope clarification remains the foundation milestone's boundary.

Primary user: a developer checking an exported snapshot across many repositories, then copying cited evidence into a terminal agent. Primary task: read authoritative changed lines together with their declarations, provenance and limitations. The focal point is the hunk text; navigation and inspection use quieter surfaces. All input/source is untrusted data.

## Layout decision and tokens

Compare [three-column wireframe](ux-flows/wireframes/workspace.html) with [wide-diff/bottom-inspector wireframe](ux-flows/wireframes/wide.html). Choose the three-column workspace at desktop widths: declaration ranges and coverage stay visible while reading. The wide alternative gives more code width but requires vertical movement to compare provenance. Both use synthetic content and are reusable static HTML, not collector integration. The working React UI implements the chosen layout.

At 1440/1280px: 248px explorer, flexible diff, 328px inspector. At 1024px: inspector is an explicit collapsible region. At 768/375px: explorer and inspector are toggled sections; reading remains central. Code scrolls inside its own region; the page never forces horizontal scrolling. Controls remain reachable with text zoom.

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

Empty complete exports say no changes in the requested comparison. Failed/partial exports preserve their reasons and retained data. Unsupported syntax says unavailable separately from Git success. Binary/gitlink/mode-only files show metadata without text. Historical exports are labeled by schema and captured time; working-tree freshness is never claimed. Invalid exports are rejected by the CLI, and browser/session/API failures have actionable error states. Review writes, state freshness and live refresh controls do not exist in this slice.

Keyboard: skip links to viewer/inspector, native buttons/selects/details, logical tab order, visible focus, Enter/Space activation, explicit previous/next hunk and responsive region controls. New file selection focuses its heading on narrow screens. Copy failure never steals evidence selection. Screen reader status uses a polite live region. Source values are plain text even when they contain HTML.

See [use cases and navigation](ux-flows/UX-FLOWS.md). Actual browser verification and screenshot references are recorded in `docs/progress.md` after checks finish.

## Reading preference

Keep the existing review workbench and tokens. Add one native pressed-state button in the preferences group: `[Bionic Reading off/on] [Language] [Theme]`. It is off on each new session; keyboard Space/Enter toggles it and mobile controls wrap. No settings file, storage, network dependency or collector option is needed.

Emphasize the first half of each word's grapheme clusters in source lines and explanatory notes, using the existing 700 weight. Use Thai word segmentation for mixed Thai/English text, preserving all original characters and whitespace; attach a Thai leading vowel to the following consonant at the emphasis boundary. Use presentation spans rather than semantic emphasis or HTML parsing. Source remains selectable as the same text, and the inspector's raw JSON and copy handoff use untouched original records. Keep IDs, hashes, paths, coordinates and controls plain.

Both inline/split layouts and themes use the same preference, independently of UI language. Without Intl.Segmenter, or for a text block exceeding 16,384 UTF-16 code units, show plain text. Browser dictionaries/font shaping may vary; this is a visual preference, not a proven reading-speed or comprehension aid. All existing partial/historical/security policies remain in force.
