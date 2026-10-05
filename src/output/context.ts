import { ScanError } from '../config/load.js';
import type { Evidence, EvidenceBundle } from '../evidence/schema.js';
import type { SyntaxEvidence, SyntaxBundle } from '../evidence/syntax.js';
import type { CandidateEvidence, CandidateBundle } from '../evidence/candidates.js';
import type { JavaSyntaxEvidence, JavaSyntaxBundle } from '../evidence/java-syntax.js';
import { messages, diagnosticMessage, type Locale } from './locale.js';

// JSON quoting keeps every repository value on one physical line. Encoding
// Markdown/HTML punctuation prevents fences, links, headings or tags escaping
// the trusted template; normal Unicode and identifiers display unchanged.
export function quoteUntrusted(value: unknown): string {
  const quoted = JSON.stringify(value).replace(/[\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<code>${quoted.replace(/[&<>"'`*_\[\]{}()#+.!|~\\=\-]/gu, char => `&#${char.charCodeAt(0)};`)}</code>`;
}
const citation = (id: string) => `\`evidence:${id}\``;
function evidenceBlock(entry: Evidence | SyntaxEvidence | CandidateEvidence | JavaSyntaxEvidence, locale: Locale, scope: string): string {
  const extraTitles: Record<string, string> = locale === 'th' ? { 'reference-query': 'ความครบถ้วนการค้นหาข้อความ', 'reference-candidate': 'ข้อความที่อาจอ้างอิง', 'related-test-query': 'ความครบถ้วนการค้นหาการทดสอบ', 'related-test-candidate': 'การทดสอบที่อาจเกี่ยวข้อง (ยังไม่รัน)', history: 'ประวัติ Git ตามพาธ' } : { 'reference-query': 'Reference search coverage', 'reference-candidate': 'Candidate text reference', 'related-test-query': 'Related test search coverage', 'related-test-candidate': 'Potential related test (not run)', history: 'Git path history' };
  const m = messages(locale); const title = extraTitles[entry.kind] ?? (entry.kind === 'symbol' ? locale === 'th' ? 'ประกาศเชิงไวยากรณ์' : 'Syntax declaration' : entry.kind === 'language-analysis' ? locale === 'th' ? 'ความครบถ้วนการวิเคราะห์ภาษา' : 'Language analysis coverage' : entry.kind === 'repository' ? m.repository : entry.kind === 'comparison' ? m.comparison : entry.kind === 'file-change' ? m.file : entry.kind === 'hunk' ? m.hunk : entry.kind === 'untracked-file' ? m.untracked : m.conflict);
  const lines = [`### ${title}`, '', `${m.evidence}: ${citation(entry.id)}`, `${m.snapshot}: \`${entry.snapshotId}\``, `${m.comparison}: ${entry.comparisonId ? `\`${entry.comparisonId}\`` : m.unavailable}`];
  lines.push(`${m.scope}: ${quoteUntrusted(scope)}`);
  if (entry.kind === 'hunk') {
    const hunk = entry.data;
    lines.push(`${m.file}: ${citation(hunk.fileEvidenceId)}`, `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`, `${m.heading}: ${quoteUntrusted(hunk.heading ?? { base64: hunk.headingBytes })}`);
    for (const line of hunk.lines) lines.push(`- ${line.kind} (old ${line.oldLine ?? '-'}, new ${line.newLine ?? '-'}): ${quoteUntrusted(line.content ?? { base64: line.contentBytes })}`);
    if (hunk.noNewlineMarkers.length) lines.push(`${m.markers}: ${quoteUntrusted(hunk.noNewlineMarkers)}`);
  } else if (entry.kind === 'repository') {
    lines.push(`${m.key}: ${quoteUntrusted(entry.data.key)}`, `${m.path}: ${quoteUntrusted(entry.data.path)}`, `${m.revisions}: ${quoteUntrusted(entry.data.revisions)}`, `${m.data}: ${quoteUntrusted({ workingTree: entry.data.workingTree, fingerprints: entry.data.fingerprints, capabilities: entry.data.capabilities, objectFormat: entry.data.objectFormat, linkedWorktree: entry.data.linkedWorktree, submodules: entry.data.submodules })}`);
  } else {
    if (entry.kind === 'comparison') lines.push(`${m.scope}: ${quoteUntrusted(entry.data.scope)}`);
    if (entry.kind === 'file-change') lines.push(`${m.comparison}: ${citation(entry.data.comparisonEvidenceId)}`);
    lines.push(`${m.data}: ${quoteUntrusted(entry.data)}`);
  }
  lines.push(`${m.source}: ${quoteUntrusted(entry.source)}`, '');
  return `${lines.join('\n')}\n`;
}
export function renderContext(bundle: EvidenceBundle | SyntaxBundle | CandidateBundle | JavaSyntaxBundle, locale: Locale, byteLimit = bundle.request.limits.maxBundleBytes) {
  const m = messages(locale); const parts: string[] = []; let bytes = 0; const omittedEvidenceIds: string[] = []; let omittedDiagnostics = 0;
  const append = (block: string, reserve = 0): boolean => { const cost = Buffer.byteLength(block); if (bytes + cost + reserve > byteLimit) return false; parts.push(block); bytes += cost; return true; };
  const mandatory = (block: string) => { if (!append(block, 2048)) throw new ScanError('CONTEXT_OUTPUT_LIMIT', 'Context metadata exceeds maxBundleBytes; narrow the workspace or increase the limit', 1); };
  const syntax = bundle.schemaVersion !== '1.0.0';
  const supported = bundle.schemaVersion === '1.3.0' ? 'TS/TSX/JS/Java' : 'TS/TSX/JS';
  const title = bundle.schemaVersion === '1.2.0' ? locale === 'th' ? 'บริบท difflearn v0.2 ตัวเลือกและประวัติ' : 'difflearn v0.2 candidate and history context' : syntax ? locale === 'th' ? 'บริบท difflearn v0.2 เชิงไวยากรณ์' : 'difflearn v0.2 syntax context' : m.title;
  const analysis = bundle.schemaVersion === '1.2.0' ? locale === 'th' ? 'ผลข้อความเป็นเพียงตัวเลือก ไม่ยืนยันผู้เรียกหรือการพึ่งพาข้ามคลัง การทดสอบเป็นเพียงข้อเสนอจากชื่อไฟล์ ข้อความ และไวยากรณ์ import และยังไม่รัน ไม่พิสูจน์การขาดการทดสอบหรือช่องว่างความครอบคลุม ประวัติ Git จำกัดที่ HEAD และพาธที่ระบุ ไม่พิสูจน์พฤติกรรมขณะรัน ไม่วิเคราะห์การอ้างอิงเชิงความหมาย LSP หรือสัญญา' : 'Text matches are candidates, including comments/strings and same-name matches across repositories; they do not confirm callers or dependencies. Potential tests use filename/text/import syntax heuristics and remain not-run. Search absence proves neither a missing test nor a coverage gap. Bounded pinned-HEAD path history does not prove runtime behavior. Semantic references, LSP, inferred behavior/contracts, impact and coverage remain unavailable.' : syntax ? locale === 'th' ? 'รองรับการประกาศและช่วงโค้ดเชิงไวยากรณ์สำหรับ TS/TSX/JS เท่านั้น การจับคู่ชื่อเป็นเพียงตัวเลือกเชิงไวยากรณ์ ไม่ใช่อัตลักษณ์เชิงความหมาย ไม่วิเคราะห์การอ้างอิงเชิงความหมาย พฤติกรรม สัญญา ชนิดค่าที่คืน ผลกระทบ ความครอบคลุมการทดสอบ ประวัติ หรือสถานะการตรวจทาน ภาษาอื่นไม่มีการวิเคราะห์สัญลักษณ์' : 'Supported: bounded TS/TSX/JS syntax declarations and source ranges. Name/scope pairings are syntactic candidates, not semantic identities. Semantic references, inferred behavior/contracts, return types, impact, test coverage, history and review state remain unsupported. Other languages have unavailable symbol analysis.' : `${m.capabilities}\n\n${m.unsupported}`;
  mandatory(`# ${title}\n\n${m.trust}\n\n${m.export}\n\n${analysis.replaceAll('TS/TSX/JS', supported)}\n\n${m.completeness}: ${m[bundle.completeness.state]}\n\n${m.reasons}: ${quoteUntrusted(bundle.completeness.reasons)}\n\n${m.scope}: ${quoteUntrusted(bundle.request.scopes)}\n\n${m.limits}: ${quoteUntrusted(bundle.request.limits)}\n\n`);
  if (bundle.schemaVersion !== '1.0.0') mandatory(`${locale === 'th' ? 'ความครบถ้วนและความสามารถด้านภาษา' : 'Language coverage and capabilities'}: ${quoteUntrusted(bundle.languageAnalysis)}\n\n`);
  if (bundle.schemaVersion === '1.2.0') mandatory(`${locale === 'th' ? 'ขอบเขตและความครบถ้วนการค้นหา' : 'Candidate discovery bounds and coverage'}: ${quoteUntrusted({ ...bundle.discoveryAnalysis, corpus: { ...bundle.discoveryAnalysis.corpus, files: undefined } })}\n\n`);
  if (!bundle.repositories.length) mandatory(`${m.empty}\n\n`);
  // Reserve all repository/snapshot headers before permitting source blocks.
  const headers = bundle.repositories.map((repo, index) => `## ${m.repository} ${index + 1}\n\n${m.path}: ${quoteUntrusted(repo.path)}\n\n${m.key}: ${quoteUntrusted(repo.key)}\n\n${m.state}: ${m[repo.state]}\n\n${m.reasons}: ${quoteUntrusted(repo.reasons)}\n\n${m.snapshot}: ${quoteUntrusted(repo.snapshot)}\n\n${m.revisions}: ${quoteUntrusted(repo.revisions)}\n\n${m.evidence}: ${repo.repositoryEvidenceId ? citation(repo.repositoryEvidenceId) : m.unavailable}\n\n`);
  let reservedHeaders = headers.reduce((sum, header) => sum + Buffer.byteLength(header), 0);
  if (bytes + reservedHeaders + 2048 > byteLimit) throw new ScanError('CONTEXT_OUTPUT_LIMIT', 'Context repository metadata exceeds maxBundleBytes', 1);
  for (let index = 0; index < bundle.repositories.length; index++) {
    const repo = bundle.repositories[index]!; const header = headers[index]!; reservedHeaders -= Buffer.byteLength(header); mandatory(header);
    for (const entry of bundle.evidence.filter(item => item.repositoryId === repo.repositoryId)) if (!append(evidenceBlock(entry, locale, bundle.request.scopes[0]!), reservedHeaders + 2048)) omittedEvidenceIds.push(entry.id);
  }
  mandatory(`## ${m.diagnostics}\n\n`);
  for (const diagnostic of bundle.diagnostics) {
    const block = `- ${diagnostic.code}: ${diagnosticMessage(diagnostic.code, locale)} ${m.path}: ${quoteUntrusted(diagnostic.path)} ${m.detail}: ${quoteUntrusted(diagnostic.message)}\n`;
    if (!append(block, 2048)) omittedDiagnostics++;
  }
  const partial = omittedEvidenceIds.length > 0 || omittedDiagnostics > 0;
  const state = partial && bundle.completeness.state === 'complete' ? 'partial' : bundle.completeness.state;
  const footer = `\n## ${m.rendering}\n\n${m.completeness}: ${m[state]}\n\n${m.omitted}: ${omittedEvidenceIds.length}; ${m.diagnostics}: ${omittedDiagnostics}\n\n${partial ? 'CONTEXT_OUTPUT_LIMIT\n' : ''}`;
  if (!append(footer)) throw new ScanError('CONTEXT_OUTPUT_LIMIT', 'Context footer exceeds its byte limit', 1);
  return { markdown: parts.join(''), state, omittedEvidenceIds, omittedDiagnostics, byteLength: bytes };
}
