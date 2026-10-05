import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { UiSession, UiPage, UiRepository, UiFile, UiHunk, UiEvidence, UiInspection, UiAppState, ReviewSelection } from '../src/ui/contracts.js';
import './style.css';
import { readingParts } from './reading.js';
import { setNonce } from 'get-nonce';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Label } from './components/ui/label.js';
import { Textarea } from './components/ui/textarea.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './components/ui/tabs.js';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './components/ui/tooltip.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from './components/ui/dialog.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './components/ui/dropdown-menu.js';
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription } from './components/ui/sheet.js';
import { Card } from './components/ui/card.js';

// Radix's scroll-lock styles carry the bridge's per-session CSP nonce.
const styleNonce = (document.getElementById('difflearn-bootstrap') as HTMLScriptElement | null)?.nonce;
if (styleNonce) setNonce(styleNonce);

function useNarrow(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => { const media = matchMedia(query), update = () => setMatches(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, [query]);
  return matches;
}

const ReadingContext = createContext(false);
function ReadingText({ children }: { children: string }) {
  const enabled = useContext(ReadingContext);
  const parts = useMemo(() => enabled ? readingParts(children) : null, [enabled, children]);
  return parts ? parts.map((part, index) => part.emphasized ? <span className="bionic-prefix" key={index}>{part.text}</span> : part.text) : children;
}

const bootstrap = document.getElementById('difflearn-bootstrap')?.textContent;
const token: string | null = bootstrap ? (JSON.parse(bootstrap) as { token: string }).token : null;
async function api<T>(route: string, signal: AbortSignal, method = 'GET'): Promise<T> {
  if (!token) throw new Error('This app session is unavailable. Run dr again in the repository.');
  const response = await fetch(route, { method, headers: { 'X-Difflearn-Session': token }, signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? `Viewer request failed (${response.status})`); }
  return response.json() as Promise<T>;
}
const GenerationContext = createContext(1);
const pages = new Map<string, unknown>();
const versioned = (route: string, generation: number) => `${route}${route.includes('?') ? '&' : '?'}generation=${generation}`;
async function cached<T>(route: string, generation: number, signal: AbortSignal): Promise<T> {
  const key = versioned(route, generation);
  if (pages.has(key)) return pages.get(key) as T;
  const value = await api<T>(key, signal); signal.throwIfAborted();
  if (pages.size >= 128) pages.delete(pages.keys().next().value!);
  pages.set(key, value); return value;
}
function useApi<T>(route: string | null) {
  const generation = useContext(GenerationContext);
  const [result, setResult] = useState<{ key: string | null; data: T | null; error: string | null; loading: boolean }>({ key: null, data: null, error: null, loading: false });
  useEffect(() => {
    if (!route) return;
    const controller = new AbortController();
    const existing = pages.get(versioned(route, generation)) as T | undefined;
    setResult({ key: route, data: existing ?? null, error: null, loading: existing === undefined });
    void cached<T>(route, generation, controller.signal).then(data => { if (!controller.signal.aborted) setResult({ key: route, data, error: null, loading: false }); }, error => { if (!controller.signal.aborted) setResult({ key: route, data: null, error: String(error.message), loading: false }); });
    return () => controller.abort();
  }, [route, generation]);
  const existing = route ? pages.get(versioned(route, generation)) as T | undefined : undefined;
  return result.key === route && route !== null ? result : { data: existing ?? null, error: null, loading: route !== null && existing === undefined };
}
type Selection = { repositoryId: string | null; file: UiFile | null; selected: UiEvidence | null; repositoryOffset: number; fileOffset: number; hunkOffset: number; inspectOffset: number; query: string; change: string };
const emptySelection: Selection = { repositoryId: null, file: null, selected: null, repositoryOffset: 0, fileOffset: 0, hunkOffset: 0, inspectOffset: 0, query: '', change: '' };
const pathOf = (file: UiFile) => file.data.destinationPath ?? file.data.originalPath;
const hunkKey = (hunk: UiHunk) => JSON.stringify(hunk.data.lines.map(line => [line.kind, line.contentBytes, line.oldNoNewline, line.newNoNewline]));
async function prepare(state: UiAppState, wanted: Selection, signal: AbortSignal): Promise<Selection> {
  const generation = state.generation;
  await cached<UiSession>('/api/session', generation, signal);
  const repositories = await cached<UiPage<UiRepository>>(`/api/repositories?offset=${wanted.repositoryOffset}`, generation, signal);
  const repositoryId = repositories.items.find(item => item.repositoryId === wanted.repositoryId)?.repositoryId ?? repositories.items[0]?.repositoryId ?? null;
  if (!repositoryId) return { ...emptySelection, repositoryOffset: wanted.repositoryOffset };
  const files = await cached<UiPage<UiFile>>(`/api/files?repositoryId=${repositoryId}&offset=${wanted.fileOffset}&q=${encodeURIComponent(wanted.query)}&change=${wanted.change}`, generation, signal);
  let file = files.items.find(item => wanted.file && pathOf(item) === pathOf(wanted.file)) ?? null;
  if (!file && wanted.file && pathOf(wanted.file)) {
    const matching = await cached<UiPage<UiFile>>(`/api/files?repositoryId=${repositoryId}&q=${encodeURIComponent(pathOf(wanted.file)!)}&change=${wanted.change}`, generation, signal);
    file = matching.items.find(item => pathOf(item) === pathOf(wanted.file!)) ?? null;
  }
  file ??= files.items[0] ?? null;
  if (!file) return { ...wanted, repositoryId, file: null, selected: null };
  const sameFile = !!wanted.file && pathOf(file) === pathOf(wanted.file);
  const hunkOffset = sameFile ? wanted.hunkOffset : 0;
  const hunks = await cached<UiPage<UiHunk>>(`/api/hunks?fileEvidenceId=${file.id}&offset=${hunkOffset}`, generation, signal);
  let selected: UiEvidence = hunks.items[0] ?? file;
  if (sameFile && wanted.selected?.kind === 'file-change') selected = file;
  if (sameFile && wanted.selected?.kind === 'hunk') {
    const previous = wanted.selected;
    const matches = hunks.items.filter(item => hunkKey(item) === hunkKey(previous));
    selected = hunks.items.find(item => item.id === previous.id) ?? (matches.length === 1 ? matches[0]! : selected);
  }
  const inspectOffset = sameFile ? wanted.inspectOffset : 0;
  if (sameFile && wanted.selected?.kind === 'symbol') {
    const inspection = await cached<UiInspection>(`/api/inspect?evidenceId=${file.id}&offset=${inspectOffset}`, generation, signal);
    const previous = wanted.selected;
    const key = (entry: typeof previous) => JSON.stringify([entry.data.language, entry.data.kind, entry.data.name, entry.data.side, entry.data.scope, 'signatureDisplay' in entry.data ? entry.data.signatureDisplay : null, entry.data.range.startLine]);
    const matches = inspection.related.items.filter((item): item is typeof previous => item.kind === 'symbol' && key(item) === key(previous));
    if (matches.length === 1) selected = matches[0]!;
  }
  await cached<UiInspection>(`/api/inspect?evidenceId=${selected.id}&offset=${inspectOffset}`, generation, signal);
  return { ...wanted, repositoryId, file, selected, hunkOffset, inspectOffset };
}

function App() {
  const [state, setState] = useState<UiAppState | null>(null), [display, setDisplay] = useState<{ state: UiAppState; initial: Selection } | null>(null);
  const [error, setError] = useState(''), [poll, setPoll] = useState(0), [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const selection = useRef(emptySelection);
  const [locale, setLocale] = useState('en'), [theme, setTheme] = useState('dark'), [bionic, setBionic] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await api<UiAppState>('/api/state', controller.signal);
        if (controller.signal.aborted) return;
        setState(next); setError('');
        if (next.phase === 'loading' || next.phase === 'refreshing') timer = setTimeout(() => void read(), 300);
        else setBusy(false);
      } catch (failure) { if (!controller.signal.aborted) { setError((failure as Error).message); setBusy(false); } }
    };
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [poll]);
  useEffect(() => {
    if (!state?.snapshot) { if (state?.phase === 'ready') { setDisplay(null); setPreparing(false); } return; }
    if (state.generation === display?.state.generation) return;
    const controller = new AbortController(); setPreparing(true);
    void prepare(state, selection.current, controller.signal).then(initial => {
      if (controller.signal.aborted) return;
      selection.current = initial; setDisplay({ state, initial }); setError(''); setPreparing(false);
    }, failure => { if (!controller.signal.aborted) { setError((failure as Error).message); setPreparing(false); } });
    return () => controller.abort();
  }, [state?.generation, display?.state.generation]);
  const refresh = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await api<UiAppState>('/api/refresh', new AbortController().signal, 'POST')); setPoll(value => value + 1); }
    catch (failure) { setBusy(false); setError((failure as Error).message); setPoll(value => value + 1); }
  };
  const review = async (wanted: ReviewSelection) => {
    if (busy) return;
    setBusy(true); setError('');
    const params = new URLSearchParams({ mode: wanted.mode });
    if (wanted.commit) params.set('commit', wanted.commit);
    if (wanted.comparisonRef) params.set('comparisonRef', wanted.comparisonRef);
    try { setState(await api<UiAppState>(`/api/review?${params}`, new AbortController().signal, 'POST')); setPoll(value => value + 1); }
    catch (failure) { setBusy(false); setError((failure as Error).message); }
  };
  const live = state?.mode === 'repository';
  const refreshing = busy || preparing || !error && (state?.phase === 'refreshing' || state?.phase === 'loading' || !!state?.snapshot && state.generation !== display?.state.generation);
  const notice = error || state?.error?.message;
  const shown = state?.snapshot && display && state.generation !== display.state.generation ? display.state : state;
  const selectedReview = shown?.reviewSelection;
  return <TooltipProvider delayDuration={300}><Tabs activationMode="manual" value={selectedReview?.mode ?? 'export'} onValueChange={mode => { if (state?.reviewSelection) void review({ ...state.reviewSelection, mode: mode as ReviewSelection['mode'], commit: null }); }}>{live ? <section className="local-session" aria-label="Local repository"><div><strong className="break">{state.root}</strong><span>Branch: {shown?.branch ?? 'detached HEAD'} · {selectedReview?.mode === 'unpushed' ? 'commit changes · captured Git objects' : 'all · HEAD → working tree'}</span></div><Button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Collecting…' : 'Refresh'}</Button></section> : null}
    {live && state.reviewSelection ? <><TabsList className="review-modes" aria-label="Review mode"><TabsTrigger value="uncommitted" disabled={refreshing}>Uncommitted changes</TabsTrigger><TabsTrigger value="unpushed" disabled={refreshing}>Unpushed commits</TabsTrigger></TabsList>{selectedReview?.mode === 'unpushed' ? <OutgoingPanel state={shown!} busy={refreshing} choose={wanted => void review(wanted)} /> : null}</> : null}
    {notice ? <div className="coverage-warning" role="alert">{notice} {live ? 'Correct the problem, then click Refresh. The last collected snapshot stays visible.' : 'Keep the terminal running or reopen the app.'}</div> : null}
    <TabsContent tabIndex={-1} className="review-content" value={selectedReview?.mode ?? 'export'}>{display ? <GenerationContext.Provider value={display.state.generation}><Workspace key={display.state.generation} initial={display.initial} live={display.state.mode === 'repository'} reviewState={display.state} preferences={{ locale, setLocale, theme, setTheme, bionic, setBionic }} report={value => { selection.current = value; }} /></GenerationContext.Provider> : <main className="startup-error"><h1>Difflearn Review Workspace</h1><p role="status">{notice ? 'No snapshot available yet.' : state?.phase === 'ready' && selectedReview?.mode === 'unpushed' ? 'Select an available commit or comparison above.' : live ? 'Collecting current changes…' : 'Opening collected evidence…'}</p>{live ? <p>The app is read-only. Keep this terminal open; Ctrl+C closes the app.</p> : null}</main>}</TabsContent></Tabs></TooltipProvider>;
}
function OutgoingPanel({ state, busy, choose }: { state: UiAppState; busy: boolean; choose: (selection: ReviewSelection) => void }) {
  const history = state.outgoing, selection = state.reviewSelection!;
  if (!history) return <section className="outgoing-panel"><p role="status">Reading local commit history…</p></section>;
  const commit = history.commits.find(item => item.oid === selection.commit);
  const needsRef = !history.comparison || history.comparison.kind === 'chosen';
  return <section className="outgoing-panel" aria-label="Outgoing commit review">
    <p className="muted">“Unpushed” means absent from the locally known upstream ref. Remote server state is not verified. Refresh rereads local refs; no fetch occurs.</p>
    {history.detached ? <p>Detached HEAD: no current branch upstream. Use an explicit local comparison.</p> : null}
    {needsRef ? <Label>Local comparison ref<NativeSelect aria-label="Local comparison ref" value={history.comparison?.ref ?? ''} disabled={busy} onChange={event => choose({ mode: 'unpushed', commit: null, comparisonRef: event.target.value })}><NativeSelectOption value="" disabled>Select a local ref…</NativeSelectOption>{history.refs.map(ref => <NativeSelectOption key={ref.ref} value={ref.ref}>{ref.ref}</NativeSelectOption>)}</NativeSelect></Label> : null}
    {history.status === 'no-upstream' ? <p>No upstream configured. Choose a local ref for an explicit comparison.</p> : history.status === 'missing-upstream' ? <p>The configured upstream {history.upstreamRef} is missing locally. Choose an available local comparison ref.</p> : history.status === 'unborn' ? <p>This branch has no HEAD commit yet.</p> : null}
    {history.comparison ? <><p className="comparison-ref break"><strong>{history.comparison.kind === 'chosen' ? 'Chosen comparison (not confirmed unpushed)' : 'Locally known upstream'}:</strong> {history.comparison.ref}<br />Captured comparison ID: <code>{history.comparison.oid}</code><br />Captured HEAD: <code>{history.head}</code></p><p>{history.ahead} ahead · {history.behind} behind{history.diverged ? ' · Diverged histories' : ''}</p></> : null}
    {history.shallow ? <p className="coverage-warning">Shallow history: counts and outgoing membership reflect locally available ancestry. Missing parents remain unavailable; completeness of remote history is not proved.</p> : null}
    {history.status === 'empty' ? <p role="status">No outgoing commits in this local comparison.</p> : null}
    {history.aggregateReason ? <p className="coverage-warning">{history.aggregateReason} Individual commits with available parents can still be reviewed.</p> : null}
    {history.ahead !== null && history.ahead > 0 ? <><Button aria-pressed={selection.commit === null} disabled={busy || !!history.aggregateReason} onClick={() => choose({ ...selection, commit: null })}>Aggregate outgoing changes</Button><p className="muted">Net diff: unique merge base → captured HEAD. This is separate from individual commit changes.</p><ol className="commit-list">{history.commits.map(item => <li key={item.oid}><Button aria-pressed={selection.commit === item.oid} disabled={busy} onClick={() => choose({ ...selection, commit: item.oid })}><code>{item.shortOid}</code><strong>{item.subject || '(empty subject)'}</strong><span>{item.author} · {item.date}</span><span>{item.parents.length > 1 ? 'Merge · first-parent comparison' : item.parents.length === 0 ? 'Root commit · empty-tree comparison' : 'Parent → commit'}</span></Button></li>)}</ol></> : null}
    {!history.complete ? <p className="coverage-warning">Commit list is partial: {history.omittedCommits} commits omitted by the 500-commit display bound. Aggregate net diff has its own coverage.</p> : null}
    {commit ? <p className="selected-commit break"><strong>{commit.parents.length > 1 ? 'First-parent comparison' : commit.parents.length === 0 ? 'Empty-tree comparison' : 'Parent comparison'}:</strong> <code>{commit.parents[0] ?? 'empty tree'}</code> → <code>{commit.oid}</code>{commit.parents.length > 1 ? <><br />Actual parents: {commit.parents.join(', ')}</> : null}{commit.unavailableReason ? <><br />{commit.unavailableReason}</> : null}</p> : history.comparison && !history.aggregateReason && history.ahead! > 0 ? <p className="break">Aggregate: <code>{history.mergeBases[0]}</code> → <code>{history.head}</code></p> : null}
  </section>;
}
const short = (value: string | null) => value ? `${value.slice(0, 12)}…` : 'unavailable';
const symbolName = (data: { name: string | null; kind: string; signatureDisplay?: string | undefined }) => data.signatureDisplay ?? data.name ?? data.kind;
type Text = (en: string, th: string) => string;
function Pager<T>({ page, change, text }: { page: UiPage<T>; change: (offset: number) => void; text: Text }) {
  return <div className="pager"><Button disabled={!page.offset} onClick={() => change(Math.max(0, page.offset - page.limit))}>{text('Previous page', 'หน้าก่อน')}</Button><span>{page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}` : '0'} / {page.total}</span><Button disabled={page.offset + page.limit >= page.total} onClick={() => change(page.offset + page.limit)}>{text('Next page', 'หน้าถัดไป')}</Button></div>;
}
type Line = UiHunk['data']['lines'][number];
function LineText({ line, text }: { line: Line | undefined; text: Text }) {
  if (!line) return <span aria-label={text('No line on this side', 'ไม่มีบรรทัดในด้านนี้')} />;
  return <><code><ReadingText>{line.content ?? text('[Text encoding unavailable; see evidence bytes]', '[ไม่สามารถแสดงข้อความ ดู bytes ในหลักฐาน]')}</ReadingText></code>{line.oldNoNewline || line.newNoNewline ? <span className="line-note">{text('No final newline', 'ไม่มี newline ท้ายไฟล์')}</span> : null}{line.content?.endsWith('\r') ? <span className="line-note">CRLF</span> : null}</>;
}
function splitLines(lines: Line[]) {
  const rows: { before?: Line; after?: Line }[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind === 'context') { const line = lines[index++]!; rows.push({ before: line, after: line }); continue; }
    const before: Line[] = [], after: Line[] = [];
    while (index < lines.length && lines[index]!.kind !== 'context') { const line = lines[index++]!; (line.kind === 'remove' ? before : after).push(line); }
    for (let ordinal = 0; ordinal < Math.max(before.length, after.length); ordinal++) rows.push({ ...(before[ordinal] ? { before: before[ordinal] } : {}), ...(after[ordinal] ? { after: after[ordinal] } : {}) });
  }
  return rows;
}
function Hunk({ hunk, split, selected, select, text }: { hunk: UiHunk; split: boolean; selected: boolean; select: () => void; text: Text }) {
  return <section className={`hunk ${selected ? 'selected' : ''}`} id={`hunk-${hunk.id}`} aria-label={`Hunk ${hunk.data.ordinal}`}>
    <Button className="hunk-heading" aria-pressed={selected} onClick={select}><span className="mono">@@ -{hunk.data.oldStart},{hunk.data.oldCount} +{hunk.data.newStart},{hunk.data.newCount} @@</span><span>{hunk.data.heading ?? ''}</span><span>{text('Inspect', 'ตรวจหลักฐาน')}</span></Button>
    <div className="code-scroll" tabIndex={0} aria-label={text('Collected hunk lines', 'บรรทัด hunk ที่เก็บรวบรวม')}>
      {split ? <div className="split-code"><div className="side-labels"><span>{text('Before', 'ก่อน')}</span><span>{text('After', 'หลัง')}</span></div>{splitLines(hunk.data.lines).map((row, ordinal) => <div className="split-row" key={ordinal}><div className={`code-side ${row.before?.kind ?? 'blank'}`}><span className="line-number">{row.before?.oldLine ?? ''}</span><div><LineText line={row.before} text={text} /></div></div><div className={`code-side ${row.after?.kind ?? 'blank'}`}><span className="line-number">{row.after?.newLine ?? ''}</span><div><LineText line={row.after} text={text} /></div></div></div>)}</div> : <div className="inline-code">{hunk.data.lines.map((line, ordinal) => <div className={`code-line ${line.kind}`} key={ordinal}><span className="line-number">{line.oldLine ?? ''}</span><span className="line-number">{line.newLine ?? ''}</span><span className="sign" aria-label={line.kind}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><div><LineText line={line} text={text} /></div></div>)}</div>}
    </div>
  </section>;
}
function Workspace({ initial, live, reviewState, preferences, report }: { initial: Selection; live: boolean; reviewState: UiAppState; preferences: { locale: string; setLocale: (value: string) => void; theme: string; setTheme: (value: string) => void; bionic: boolean; setBionic: (value: boolean) => void }; report: (value: Selection) => void }) {
  const { locale, setLocale, theme, setTheme, bionic, setBionic } = preferences;
  const text: Text = (en, th) => locale === 'th' ? th : en;
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.lang = locale; }, [theme, locale]);
  const session = useApi<UiSession>('/api/session');
  const [repositoryOffset, setRepositoryOffset] = useState(initial.repositoryOffset), [repositoryId, setRepositoryId] = useState<string | null>(initial.repositoryId);
  const repositories = useApi<UiPage<UiRepository>>(session.data ? `/api/repositories?offset=${repositoryOffset}` : null);
  const [query, setQuery] = useState(initial.query), [change, setChange] = useState(initial.change), [fileOffset, setFileOffset] = useState(initial.fileOffset), [file, setFile] = useState<UiFile | null>(initial.file);
  const files = useApi<UiPage<UiFile>>(repositoryId ? `/api/files?repositoryId=${repositoryId}&offset=${fileOffset}&q=${encodeURIComponent(query)}&change=${change}` : null);
  const [hunkOffset, setHunkOffset] = useState(initial.hunkOffset), [selectedId, setSelectedId] = useState<string | null>(initial.selected?.id ?? null), [inspectOffset, setInspectOffset] = useState(initial.inspectOffset);
  const hunks = useApi<UiPage<UiHunk>>(file ? `/api/hunks?fileEvidenceId=${file.id}&offset=${hunkOffset}` : null);
  const inspection = useApi<UiInspection>(selectedId ? `/api/inspect?evidenceId=${selectedId}&offset=${inspectOffset}` : null);
  const [split, setSplit] = useState(false), [explorerOpen, setExplorerOpen] = useState(false), [inspectorOpen, setInspectorOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false), [actionsOpen, setActionsOpen] = useState(false);
  const narrowExplorer = useNarrow('(max-width:768px)'), narrowInspector = useNarrow('(max-width:1100px)');
  const focusViewerOnClose = useRef(false), focusInspectorOnOpen = useRef(false);
  const [status, setStatus] = useState(''), [handoff, setHandoff] = useState(''); const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!repositoryId && repositories.data?.items[0]) setRepositoryId(repositories.data.items[0].repositoryId); }, [repositories.data, repositoryId]);
  useEffect(() => { if (!file && files.data?.items[0]) setFile(files.data.items[0]); }, [files.data, file]);
  useEffect(() => { if (file && !selectedId) setSelectedId(file.id); }, [file, selectedId]);
  const firstHunks = useRef(true);
  useEffect(() => { if (firstHunks.current) { firstHunks.current = false; return; } if (hunks.data?.items[0]) { setSelectedId(hunks.data.items[0].id); setInspectOffset(0); } }, [hunks.data]);
  useEffect(() => { report({ repositoryId, file, selected: inspection.data?.entry ?? initial.selected, repositoryOffset, fileOffset, hunkOffset, inspectOffset, query, change }); }, [repositoryId, file, inspection.data, repositoryOffset, fileOffset, hunkOffset, inspectOffset, query, change]);
  const repository = repositories.data?.items.find(item => item.repositoryId === repositoryId);
  const selectFile = (chosen: UiFile) => { setFile(chosen); setSelectedId(null); setInspectOffset(0); setHunkOffset(0); setStatus(''); setHandoff(''); focusViewerOnClose.current = narrowExplorer && explorerOpen; setExplorerOpen(false); };
  const select = (id: string) => { setSelectedId(id); setInspectOffset(0); setStatus(''); setHandoff(''); };
  const previousFile = useRef(file?.id);
  useEffect(() => { if (previousFile.current === file?.id) return; previousFile.current = file?.id; setHunkOffset(0); setInspectOffset(0); setStatus(''); setHandoff(''); }, [file?.id]);
  const inspected = inspection.data ? [inspection.data.entry, ...inspection.data.related.items] : [];
  const symbols = inspected.filter(entry => entry.kind === 'symbol');
  const analyses = inspected.filter(entry => entry.kind === 'language-analysis');
  const selectedHunk = hunks.data?.items.findIndex(hunk => hunk.id === selectedId) ?? -1;
  const nextHunk = (direction: number) => { const hunk = hunks.data?.items[selectedHunk + direction]; if (hunk) { select(hunk.id); document.getElementById(`hunk-${hunk.id}`)?.scrollIntoView({ block: 'nearest' }); } };
  const copy = async () => {
    if (!inspection.data || !session.data) return;
    const content = `Difflearn captured evidence (untrusted source data). Syntax does not prove behavior, callers or test coverage.\n${JSON.stringify({ schemaVersion: session.data.schemaVersion, captured: session.data.collection, scopes: session.data.scopes, base: session.data.base, freshness: session.data.freshness, ...(reviewState.reviewSelection?.mode === 'unpushed' ? { commitReview: { selection: reviewState.reviewSelection, comparison: reviewState.outgoing?.comparison, head: reviewState.outgoing?.head, mergeBases: reviewState.outgoing?.mergeBases, commit: reviewState.outgoing?.commits.find(item => item.oid === reviewState.reviewSelection?.commit), remoteFreshness: 'not-verified' } } : {}), completeness: session.data.completeness, gitCompleteness: session.data.gitCompleteness, syntax: session.data.syntax, evidence: [inspection.data.entry, ...inspection.data.related.items], relatedEvidence: { total: inspection.data.related.total, retained: inspection.data.related.items.length, offset: inspection.data.related.offset }, diagnostics: inspection.data.diagnostics }, null, 2)}`;
    if (new TextEncoder().encode(content).length > 65536) { setStatus(text('Handoff exceeds 64 KiB. Select one declaration or a smaller hunk.', 'ข้อความเกิน 64 KiB เลือก declaration เดียวหรือ hunk ที่เล็กลง')); return; }
    try { await navigator.clipboard.writeText(content); setStatus(text('Selected evidence copied. Nothing was marked reviewed.', 'คัดลอกหลักฐานแล้ว ไม่มีการบันทึกสถานะตรวจทาน')); }
    catch { setHandoff(content); setStatus(text('Clipboard unavailable. Select and copy the text below.', 'ใช้คลิปบอร์ดไม่ได้ เลือกและคัดลอกข้อความด้านล่าง')); }
  };
  if (session.error) return <main className="startup-error"><h1>Difflearn Review Workspace</h1><h2>{text('Cannot open this evidence session', 'เปิด session หลักฐานนี้ไม่ได้')}</h2><p role="alert">{session.error}</p><p>{text('Return to the terminal and run dr ui --evidence <export.json> with a valid export. Sessions expire after 30 minutes.', 'กลับไปที่ terminal แล้วใช้ dr ui --evidence <export.json> กับ export ที่ถูกต้อง session มีอายุ 30 นาที')}</p></main>;
  if (!session.data) return <main className="startup-error"><h1>Difflearn Review Workspace</h1><p role="status">{text('Opening validated captured evidence…', 'กำลังเปิดหลักฐานที่ตรวจแล้ว…')}</p></main>;
  const capture = session.data;
  const explorer = <aside id="explorer" className="explorer" aria-label={text('Repository and file explorer', 'รายการ repository และไฟล์')}><h2>{text('Repositories', 'Repositories')} <span className="count">{capture.repositoryCount}</span></h2>
        {repositories.error ? <p role="alert">{repositories.error}</p> : null}{repositories.data ? <><ul className="repository-list">{repositories.data.items.map(item => <li key={item.repositoryId}><Button className="repository-button" aria-pressed={repositoryId === item.repositoryId} onClick={() => { setRepositoryId(item.repositoryId); setFile(null); setSelectedId(null); setFileOffset(0); setQuery(''); setChange(''); }}><span>{item.path}</span><span className={`state ${item.state}`}>{item.state}</span></Button></li>)}</ul><Pager page={repositories.data} change={offset => { setRepositoryOffset(offset); setRepositoryId(null); setFile(null); setSelectedId(null); setFileOffset(0); }} text={text} /></> : null}
        {repository ? <details className="repository-details"><summary>{text('Snapshot and revisions', 'Snapshot และ revisions')}</summary><p className="break">snapshot: {repository.snapshot.snapshotId ?? 'unavailable'}<br />HEAD: {repository.revisions?.head.oid ?? 'unavailable'}<br />merge-base: {repository.revisions?.mergeBase.oid ?? 'unavailable'}</p><p>{repository.reasons.join(', ')}</p></details> : null}
        <h2>{text('Changed files', 'ไฟล์ที่เปลี่ยน')} <span className="count">{files.data?.total ?? '…'}</span></h2><Label className="filter">{text('Filter paths', 'ค้นหาพาธ')}<Input value={query} maxLength={256} onChange={event => { setQuery(event.target.value); setFileOffset(0); setFile(null); setSelectedId(null); }} placeholder={text('Path or Thai identifier', 'พาธหรือชื่อภาษาไทย')} /></Label><Label className="filter">{text('Change type', 'ชนิดการเปลี่ยนแปลง')}<NativeSelect aria-label={text('Change type', 'ชนิดการเปลี่ยนแปลง')} value={change} onChange={event => { setChange(event.target.value); setFileOffset(0); setFile(null); setSelectedId(null); }}><NativeSelectOption value="">{text('All changes', 'ทั้งหมด')}</NativeSelectOption>{['A', 'M', 'D', 'R', 'T'].map(kind => <NativeSelectOption key={kind} value={kind}>{kind}</NativeSelectOption>)}</NativeSelect></Label>
        {files.loading ? <p role="status">{text('Loading files…', 'กำลังโหลดไฟล์…')}</p> : null}{files.error ? <p role="alert">{files.error}</p> : null}{files.data ? <><ul className="file-list">{files.data.items.map(item => <li key={item.id}><Button aria-pressed={file?.id === item.id} onClick={() => selectFile(item)}><span className="change-kind">{item.data.status}</span><span>{item.data.destinationPath ?? item.data.originalPath ?? '[path encoding unavailable]'}</span></Button></li>)}</ul><Pager page={files.data} change={offset => { setFileOffset(offset); setFile(null); setSelectedId(null); }} text={text} /></> : null}
      </aside>;
  const inspector = <aside id="inspector" className="inspector" tabIndex={-1} aria-label={text('Evidence inspector', 'ตรวจหลักฐาน')}><div className="inspector-heading"><h2>{text('Evidence inspector', 'ตรวจหลักฐาน')}</h2></div><p className="syntax-policy"><ReadingText>{text('Syntax only. No behavior, semantic callers or test coverage is proved.', 'ไวยากรณ์เท่านั้น ไม่พิสูจน์พฤติกรรม ผู้เรียกเชิงความหมาย หรือ test coverage')}</ReadingText></p>
        {inspection.loading ? <p role="status">{text('Loading evidence…', 'กำลังโหลดหลักฐาน…')}</p> : null}{inspection.error ? <p role="alert">{inspection.error}</p> : null}{inspection.data ? <><div className="selected-evidence"><span>{inspection.data.entry.kind}</span><code className="break">{inspection.data.entry.id}</code></div>
          <h3>{text('Declarations', 'Declarations')}</h3>{symbols.length ? <ul className="symbol-list">{symbols.map(symbol => <li key={symbol.id}><Button onClick={() => select(symbol.id)}><strong>{symbolName(symbol.data)}</strong><span>{symbol.data.language} / {symbol.data.kind} / {symbol.data.side}</span><span>{text('Lines', 'บรรทัด')} {symbol.data.range.startLine}–{symbol.data.range.endLine}; {text('bytes', 'bytes')} {symbol.data.range.startByte}–{symbol.data.range.endByte}</span><span className={symbol.data.matching === 'ambiguous' ? 'warning-text' : ''}>{symbol.data.matching === 'candidate' ? text('Syntactic candidate', 'ตัวเลือกจับคู่เชิงไวยากรณ์') : symbol.data.matching}</span><span>{symbol.data.scope.map(scope => scope.name ?? `[${scope.kind}]`).join(' / ')}</span></Button></li>)}</ul> : <p className="muted">{capture.syntax.state === 'not-requested' ? text('Syntax not requested in this export. Export with --symbols for Java declarations.', 'export นี้ไม่ได้ขอ syntax ใช้ --symbols เพื่อเก็บ Java declarations') : text('No linked declarations retained for this selection/page. Check syntax coverage.', 'ไม่มี declarations ที่เชื่อมกับรายการ/หน้านี้ ตรวจความครบถ้วน syntax')}</p>}
          {analyses.map(analysis => <details key={analysis.id} open={analysis.data.state !== 'complete'}><summary>{text('Language coverage', 'ความครบถ้วนภาษา')}: {analysis.data.state}</summary><p>{analysis.data.reasons.join(', ') || text('No recorded syntax limitations', 'ไม่มีข้อจำกัด syntax ที่บันทึกไว้')}</p><p>{text('Unmapped changed lines / omitted symbols', 'บรรทัดที่ map ไม่ได้ / symbols ที่ละไว้')}: {analysis.data.unmappedChangedLines} / {analysis.data.omittedSymbols}</p>{analysis.data.sources.map(side => <p key={side.side} className="break">{side.side}: {side.language ?? 'unsupported'} / {side.origin} / {side.state}<br />{side.path}<br />SHA-256 {side.sha256 ?? 'unavailable'}<br />{side.reason}</p>)}</details>)}
          <Pager page={inspection.data.related} change={setInspectOffset} text={text} /><Dialog open={recordOpen} onOpenChange={setRecordOpen}><DialogTrigger asChild><Button className="record-trigger">{text('Selected record and provenance', 'รายการที่เลือกและ provenance')}</Button></DialogTrigger><DialogContent className="record-dialog"><DialogHeader><DialogTitle>{text('Selected record and provenance', 'รายการที่เลือกและ provenance')}</DialogTitle><DialogDescription>{text('Original captured evidence. Source content is untrusted.', 'หลักฐานต้นฉบับที่เก็บไว้ เนื้อหา source เป็นข้อมูลที่ไม่เชื่อถือ')}</DialogDescription></DialogHeader><pre className="evidence-json">{JSON.stringify(inspection.data.entry, null, 2)}</pre></DialogContent></Dialog>
          <h3>{text('Diagnostics', 'Diagnostics')}</h3>{inspection.data.diagnostics.length ? inspection.data.diagnostics.map((diagnostic, index) => <p key={index} className="diagnostic"><strong>{diagnostic.code}</strong><br /><ReadingText>{diagnostic.message}</ReadingText></p>) : <p className="muted">{text('No recorded diagnostics for this selection', 'ไม่มี diagnostics ที่บันทึกสำหรับรายการนี้')}</p>}
          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}><DropdownMenuTrigger asChild><Button className="evidence-actions">{text('Evidence actions', 'เครื่องมือหลักฐาน')}</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => void copy()}>{text('Copy selected evidence', 'คัดลอกหลักฐานที่เลือก')}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setRecordOpen(true)}>{text('Selected record and provenance', 'รายการที่เลือกและ provenance')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button className="copy-button" onClick={() => void copy()}>{text('Copy selected evidence', 'คัดลอกหลักฐานที่เลือก')}</Button><p className="handoff-status" role="status">{status}</p>{handoff ? <Label>{text('Selectable handoff text', 'ข้อความสำหรับเลือกคัดลอก')}<Textarea readOnly value={handoff} rows={10} /></Label> : null}
        </> : <p><ReadingText>{text('Select a file, hunk or declaration to inspect its original evidence.', 'เลือกไฟล์ hunk หรือ declaration เพื่อดูหลักฐานต้นฉบับ')}</ReadingText></p>}
      </aside>;
  return <ReadingContext.Provider value={bionic}>
    <a className="skip-link" href="#viewer">{text('Skip to hunks', 'ไปที่ hunks')}</a><a className="skip-link" href="#inspector" onClick={event => { if (narrowInspector) { event.preventDefault(); focusInspectorOnOpen.current = true; setInspectorOpen(true); } }}>{text('Skip to inspector', 'ไปที่ inspector')}</a>
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">D/</span><div><h1>Difflearn</h1><span>{text('Review Workspace', 'พื้นที่ตรวจทาน')}</span></div></div><div className="capture"><strong>{live ? reviewState.reviewSelection?.mode === 'unpushed' ? 'Commit changes · Read-only' : 'Local changes · Read-only' : text('Captured export · Read-only', 'หลักฐานจาก export · อ่านอย่างเดียว')}</strong><span>{capture.schemaVersion !== '1.3.0' ? text('Historical schema', 'schema รุ่นก่อน') : text('Java syntax schema', 'schema ไวยากรณ์ Java')} {capture.schemaVersion} · {capture.collection.endedAt}</span><span>{live ? 'Collected snapshot · Refresh to update' : text('Working-tree freshness not checked', 'ยังไม่ได้ตรวจความสดของ working tree')}</span></div><div className="preferences"><Tooltip><TooltipTrigger asChild><Button aria-pressed={bionic} onClick={() => setBionic(!bionic)}>Bionic Reading</Button></TooltipTrigger><TooltipContent>{text("Emphasize word beginnings in hunks and reading notes; original evidence stays unchanged", "เน้นต้นคำใน hunks และคำอธิบาย โดยไม่เปลี่ยนหลักฐานต้นฉบับ")}</TooltipContent></Tooltip><Label>{text('Language', 'ภาษา')}<NativeSelect aria-label={text('Language', 'ภาษา')} value={locale} onChange={event => setLocale(event.target.value)}><NativeSelectOption value="en">English</NativeSelectOption><NativeSelectOption value="th">ไทย</NativeSelectOption></NativeSelect></Label><Button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? text('Light theme', 'ธีมสว่าง') : text('Dark theme', 'ธีมมืด')}</Button></div></header>
    <div className="snapshot-bar"><span>{text('Scope', 'Scope')}: <strong>{capture.scopes.join(', ')}</strong></span><span>{text('Base', 'Base')}: <strong>{capture.base ?? text('Unavailable', 'ไม่มีข้อมูล')}</strong></span><span>Git: <strong>{capture.gitCompleteness.state}</strong></span><span>{text('Syntax', 'ไวยากรณ์')}: <strong>{capture.syntax.state}</strong></span><span>{text('References / tests / history', 'References / tests / history')}: {capture.discovery.references} / {capture.discovery.relatedTests} / {capture.discovery.history}</span></div>
    {capture.completeness.state !== 'complete' ? <div className="coverage-warning" role="status">{live ? 'Some changes or declarations could not be collected. Retained evidence is shown; absence is not proof of no changes.' : text('Partial or failed export. Retained evidence is shown; absence is not proof of no changes.', 'export ไม่ครบหรือมีส่วนล้มเหลว แสดงเฉพาะหลักฐานที่เก็บได้ การไม่มีข้อมูลไม่พิสูจน์ว่าไม่มีการเปลี่ยนแปลง')}<details><summary>{text('Coverage reasons', 'เหตุผลความไม่ครบถ้วน')}</summary><p>{capture.completeness.reasons.join(', ')}</p>{live && capture.completeness.reasons.some(reason => /UNBORN|HEAD_UNRESOLVED|BASE_UNRESOLVED/u.test(reason)) ? <p>Create the first commit in this repository, then click Refresh to compare against HEAD.</p> : null}</details></div> : null}
    <nav className="region-controls" aria-label={text('Workspace regions', 'ส่วนของพื้นที่ตรวจทาน')}><Sheet open={narrowExplorer && explorerOpen} onOpenChange={setExplorerOpen}><SheetTrigger asChild><Button className="explorer-trigger">{text('Repositories and files', 'Repositories และไฟล์')}</Button></SheetTrigger><SheetContent side="left" className="workspace-sheet" onCloseAutoFocus={event => { if (focusViewerOnClose.current) { event.preventDefault(); focusViewerOnClose.current = false; heading.current?.focus(); } }}><SheetTitle className="sr-only">{text('Repositories and files', 'Repositories และไฟล์')}</SheetTitle><SheetDescription className="sr-only">{text('Choose captured repositories and files.', 'เลือก repository และไฟล์ที่เก็บไว้')}</SheetDescription>{explorer}</SheetContent></Sheet><Sheet open={narrowInspector && inspectorOpen} onOpenChange={setInspectorOpen}><SheetTrigger asChild><Button>{text('Evidence inspector', 'ตรวจหลักฐาน')}</Button></SheetTrigger><SheetContent className="workspace-sheet" onOpenAutoFocus={event => { if (focusInspectorOnOpen.current) { event.preventDefault(); focusInspectorOnOpen.current = false; document.getElementById('inspector')?.focus(); } }}><SheetTitle className="sr-only">{text('Evidence inspector', 'ตรวจหลักฐาน')}</SheetTitle><SheetDescription className="sr-only">{text('Inspect captured evidence and its completeness.', 'ตรวจหลักฐานที่เก็บไว้และความครบถ้วน')}</SheetDescription>{inspector}</SheetContent></Sheet></nav>
    <div className="workspace" data-explorer-open={explorerOpen} data-inspector-open={inspectorOpen}>
      {!narrowExplorer ? <Card className="workspace-surface">{explorer}</Card> : null}
      <main id="viewer" className="viewer" tabIndex={-1}>
        {file ? <><div className="file-heading"><div><h2 ref={heading} tabIndex={-1}>{file.data.destinationPath ?? file.data.originalPath ?? '[path encoding unavailable]'}</h2>{file.data.status === 'R' ? <p>{text('Renamed from', 'เปลี่ยนชื่อจาก')} {file.data.originalPath}</p> : null}<p className="file-meta">{file.data.status} · {file.data.oldMode} → {file.data.newMode} · +{file.data.added ?? '?'} −{file.data.deleted ?? '?'}</p><p className="mono muted">snapshot {short(file.snapshotId)} / comparison {short(file.comparisonId)}</p></div><Button onClick={() => { select(file.id); setInspectorOpen(true); }}>{text('File evidence', 'หลักฐานไฟล์')}</Button></div>
          <Tabs value={split ? 'split' : 'inline'} onValueChange={value => setSplit(value === 'split')}><div className="viewer-toolbar"><TabsList className="segmented" aria-label={text('Hunk presentation', 'รูปแบบ hunk')}><TabsTrigger value="inline">{text('Inline', 'รวมบรรทัด')}</TabsTrigger><TabsTrigger value="split">{text('Split', 'แยกก่อน/หลัง')}</TabsTrigger></TabsList><div className="hunk-navigation"><Button disabled={selectedHunk <= 0} onClick={() => nextHunk(-1)}>{text('Previous hunk', 'hunk ก่อน')}</Button><Button disabled={!hunks.data || selectedHunk < 0 || selectedHunk >= hunks.data.items.length - 1} onClick={() => nextHunk(1)}>{text('Next hunk', 'hunk ถัดไป')}</Button></div></div>
          <p className="collection-note"><ReadingText>{text('Only collected hunks are shown. Source outside these ranges is not collected.', 'แสดงเฉพาะ hunks ที่เก็บรวบรวม ไม่ได้เก็บ source นอกช่วงเหล่านี้')}</ReadingText></p>
          {file.data.patch.state !== 'complete' ? <p className="coverage-warning">{text('Patch coverage', 'ความครบถ้วน patch')}: {file.data.patch.state}; {file.data.patch.reasons.join(', ')}. {text('Omitted hunks', 'hunks ที่ละไว้')}: {file.data.patch.omittedHunks ?? text('unknown', 'ไม่ทราบจำนวน')}</p> : null}
          <TabsContent value={split ? 'split' : 'inline'} className="hunk-content">{hunks.loading ? <p role="status">{text('Loading collected hunks…', 'กำลังโหลด hunks…')}</p> : null}{hunks.error ? <p role="alert">{hunks.error}</p> : null}
          {hunks.data ? <>{hunks.data.items.map((hunk, index) => <div key={hunk.id}>{index > 0 && (hunk.data.oldStart > hunks.data!.items[index - 1]!.data.oldStart + hunks.data!.items[index - 1]!.data.oldCount || hunk.data.newStart > hunks.data!.items[index - 1]!.data.newStart + hunks.data!.items[index - 1]!.data.newCount) ? <p className="uncollected-gap">{text('Uncollected source between hunks', 'ไม่ได้เก็บ source ระหว่าง hunks')}</p> : null}<Hunk hunk={hunk} split={split} selected={selectedId === hunk.id} select={() => { select(hunk.id); setInspectorOpen(true); }} text={text} /></div>)}{!hunks.data.total ? <div className="metadata-state"><h3>{file.data.binary ? text('Binary file', 'ไฟล์ binary') : file.data.kind === 'gitlink' ? 'Gitlink' : file.data.status === 'M' && file.data.oldMode !== file.data.newMode && file.data.added === 0 && file.data.deleted === 0 ? text('Mode-only change', 'เปลี่ยนเฉพาะ mode') : text('No collected text hunks', 'ไม่มี text hunks ที่เก็บรวบรวม')}</h3><p><ReadingText>{text('Inspect the modes, patch representation and coverage. No full source is reconstructed.', 'ตรวจ modes รูปแบบ patch และความครบถ้วน ไม่มีการสร้าง source file เต็มขึ้นมา')}</ReadingText></p><p>{file.data.patch.representation} / {file.data.patch.state}</p></div> : null}<Pager page={hunks.data} change={setHunkOffset} text={text} /></> : null}</TabsContent></Tabs>
        </> : <div className="empty-state"><span className="empty-mark" aria-hidden="true">D/</span><h2>{files.data?.total === 0 && capture.completeness.state === 'complete' && !query && !change ? text('No changes in this comparison', 'ไม่มีการเปลี่ยนแปลงใน comparison นี้') : text('Select retained evidence', 'เลือกหลักฐานที่เก็บรวบรวม')}</h2><p><ReadingText>{text('Choose a repository and file. Failed or omitted coverage is not a clean result.', 'เลือก repository และไฟล์ ส่วนที่ล้มเหลวหรือถูกละไว้ไม่ใช่ผลว่าไม่มีการเปลี่ยนแปลง')}</ReadingText></p>{repository?.state === 'failed' ? <p className="coverage-warning">{repository.reasons.join(', ')}</p> : null}{!capture.repositoryCount ? <p>{text('No repositories retained in this export. Check the export coverage.', 'ไม่มี repository ที่เก็บไว้ใน export นี้ ตรวจความครบถ้วนของ export')}</p> : null}</div>}
      </main>
      {!narrowInspector ? <Card className="workspace-surface">{inspector}</Card> : null}
    </div><footer className="session-footer">{live ? 'Read-only snapshot. Refresh collects current changes. Keep the terminal open; Ctrl+C closes the app.' : text('Captured evidence only. Review writes and live refresh are not enabled.', 'อ่านหลักฐานจาก export เท่านั้น ยังไม่เปิดการเขียน review state หรือ live refresh')} {capture.expiresAt ? `· ${text('Session expires', 'session หมดอายุ')}: ${capture.expiresAt}` : ''}</footer>
  </ReadingContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<App />);
