# Review Workspace use cases and navigation

The user's explicit continuation instruction authorizes these flows without a separate design approval round.

| ID | Actor / task | Preconditions | Main flow | Alternatives | Postcondition |
| --- | --- | --- | --- | --- | --- |
| UC-001 | Developer inspects exported changes | Explicit local export | Validate → open workspace → select repo/file → read hunks → inspect declarations/provenance | Invalid refuses startup; empty/partial/unsupported/binary/mode-only/historical state stays honest | Original captured evidence is visible; no workspace/state write |
| UC-002 | Developer hands evidence to a terminal agent | Selected retained evidence | Select hunk → copy evidence → paste explicitly in terminal | Bound exceeded: narrow selection; clipboard denied: selectable text | Cited plain data is available; no upload or acknowledgment |
| UC-003 | Developer opens current local changes | Inside a Git worktree with Git/Node installed | Run `dr` → browser opens → loading → collected workspace | Browser denied: terminal URL; outside Git: instruction; failed collection: correct problem and Refresh | One guarded `all` snapshot against HEAD; no remote or export required |
| UC-004 | Developer explicitly updates changes | Running local app | Refresh → retain current display → collect and validate → prepare all visible evidence → replace together | Partial replaces with honest coverage; failure retains last snapshot; concurrent Refresh disabled | File/path and unique hunk selection retained when applicable; no automatic acknowledgment |

## Local startup and Refresh design

The existing three-column workspace stays unchanged. A persistent repository strip shows the canonical worktree path, captured branch and `all · HEAD → working tree`, with a keyboard-accessible Refresh button. The first screen is useful before collection finishes: clear loading text, actual location and terminal lifetime. Empty means a complete collection with zero tracked net changes. Partial coverage and unborn HEAD are explained rather than presented as a clean result. Errors retain the last collected view and ask the user to correct the problem and Refresh. Browser launch failure prints the URL and keeps the server alive. Refresh is explicit; no watch mode, writes or review acknowledgments.

Reusable clickable wireframe: [local startup and refresh](wireframes/startup.html), linking to the existing workspace and states. Existing language/reading controls are preserved; no follow-up language or Bionic work is part of this change.

```mermaid
flowchart TD
  Dr[Run dr here] --> Git{Inside a Git worktree?}
  Git -->|No| Instruction[Run dr inside a Git repository]
  Git -->|Yes| Loading[Open browser and show actual repository]
  Loading --> Collect[Collect all against HEAD]
  Collect --> View[Ready, empty or partial workspace]
  Collect --> Error[Actionable error and Refresh]
  View --> Refresh[Explicit Refresh]
  Error --> Refresh
  Refresh --> Collect
```

```mermaid
stateDiagram-v2
  [*] --> Loading
  Loading --> Ready: validated and prepared snapshot
  Loading --> Error: collection failed
  Ready --> Refreshing: explicit Refresh
  Refreshing --> Ready: atomic replacement, including empty or partial
  Refreshing --> Error: retain previous snapshot
  Error --> Refreshing: correct problem and Refresh
  Ready --> Closed: Ctrl+C
  Loading --> Closed: Ctrl+C
  Refreshing --> Closed: abort collection and listener
```

```mermaid
sequenceDiagram
  participant User
  participant CLI
  participant Collector
  participant UI
  User->>CLI: dr inside worktree
  CLI->>CLI: resolve root, bind loopback, open browser once
  UI->>CLI: read state (loading)
  CLI->>Collector: guarded all scope, base HEAD, syntax
  Collector-->>CLI: validated bundle or error
  UI->>CLI: read one generation of visible pages
  UI->>UI: publish complete view together
  User->>UI: Refresh
  UI->>CLI: same-origin authenticated refresh
  CLI->>Collector: recollect fixed worktree
  UI->>UI: retain old snapshot until replacement ready
  User->>CLI: Ctrl+C
  CLI->>Collector: abort
  CLI->>CLI: close listener and child processes
```

Screen map: terminal → loading → existing workspace (empty/partial/error variants); Refresh returns through loading while preserving the current view. Export viewing remains the separate existing explicit flow.

```mermaid
flowchart TD
  Export[Explicit export] --> Valid{Version and facts valid?}
  Valid -->|No| Error[CLI error with correction]
  Valid -->|Yes| Workspace[Review Workspace]
  Error --> Export
  Workspace --> Select[Repository and file]
  Select --> Hunk[Collected hunk]
  Hunk --> Inspector[Declaration and provenance]
  Inspector --> Handoff[Copy selected evidence]
  Handoff --> Workspace
```

## UC-001

```mermaid
flowchart TD
  Start[Open export] --> Check{Valid?}
  Check -->|No| Fix[Re-export supported version]
  Check -->|Yes| Repo[Select repository]
  Repo --> File[Select file]
  File --> Text{Text hunks collected?}
  Text -->|Yes| Read[Read exact hunk lines]
  Text -->|No| Metadata[Read modes and limitation]
  Read --> Inspect[Inspect linked declarations]
  Metadata --> Inspect
  Inspect --> Repo
  Fix --> Start
```

```mermaid
stateDiagram-v2
  [*] --> Loading
  Loading --> Invalid: rejected export
  Loading --> Empty: no retained files
  Loading --> Ready: validated projection
  Ready --> Partial: explicit coverage reasons
  Ready --> MetadataOnly: no text representation
  Partial --> Ready: select retained peer
  MetadataOnly --> Ready: select text peer
  Invalid --> [*]
  Empty --> [*]
```

```mermaid
sequenceDiagram
  participant User
  participant CLI
  participant Reader
  participant Bridge
  participant UI
  User->>CLI: ui --evidence export.json
  CLI->>Reader: bounded read and version validation
  Reader-->>CLI: accepted immutable bundle or error
  CLI->>Bridge: start loopback session
  UI->>Bridge: GET session/repositories/files (session header)
  Bridge-->>UI: original IDs and coverage
  UI->>Bridge: GET hunks/inspect (selected evidence IDs)
  Bridge-->>UI: retained records and provenance
```

## UC-002

```mermaid
flowchart TD
  Selected[Selected hunk] --> Build[Bounded cited handoff]
  Build --> Fits{Within bound?}
  Fits -->|No| Narrow[Narrow selected evidence]
  Fits -->|Yes| Copy{Clipboard permitted?}
  Copy -->|Yes| Paste[Explicit terminal paste]
  Copy -->|No| Text[Selectable text fallback]
  Text --> Paste
  Narrow --> Selected
```

```mermaid
stateDiagram-v2
  [*] --> Selected
  Selected --> Copying: user click
  Copying --> Copied: clipboard accepted
  Copying --> Fallback: clipboard refused
  Copying --> TooLarge: byte bound
  TooLarge --> Selected
  Fallback --> Selected
  Copied --> Selected
```

```mermaid
sequenceDiagram
  participant User
  participant UI
  participant Clipboard
  User->>UI: Copy selected evidence
  UI->>UI: preserve IDs/coverage and check byte bound
  UI->>Clipboard: write plain text
  Clipboard-->>UI: success or refusal
  UI-->>User: copied status or selectable fallback
  Note over UI: No network upload or review write
```

## Wireframe inventory

| Screen | Purpose | Link | Outgoing navigation |
| --- | --- | --- | --- |
| Workspace | Chosen three-column reading/inspection | [workspace.html](wireframes/workspace.html) | wide layout, honest states |
| Wide workspace | Compare bottom inspector | [wide.html](wireframes/wide.html) | chosen workspace, honest states |
| States | Empty/partial/unsupported/binary/historical/invalid examples | [states.html](wireframes/states.html) | both layouts |

Each is synthetic, static and clickable. The same named layout regions/tokens carry into the working UI; fixture content is not a real exported integration result.
