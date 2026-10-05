# Review Workspace use cases and navigation

The user's explicit continuation instruction authorizes these flows without a separate design approval round.

| ID | Actor / task | Preconditions | Main flow | Alternatives | Postcondition |
| --- | --- | --- | --- | --- | --- |
| UC-001 | Developer inspects exported changes | Explicit local export | Validate → open workspace → select repo/file → read hunks → inspect declarations/provenance | Invalid refuses startup; empty/partial/unsupported/binary/mode-only/historical state stays honest | Original captured evidence is visible; no workspace/state write |
| UC-002 | Developer hands evidence to a terminal agent | Selected retained evidence | Select hunk → copy evidence → paste explicitly in terminal | Bound exceeded: narrow selection; clipboard denied: selectable text | Cited plain data is available; no upload or acknowledgment |

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
