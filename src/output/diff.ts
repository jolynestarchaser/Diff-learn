import type { RepositoryStatus } from '../git/collector.js';
import { renderStatus } from './status.js';

export function renderDiff(repositories: RepositoryStatus[], root: string, state: string, locale: 'en' | 'th'): string {
  let output = renderStatus(repositories, root, state, locale);
  output += locale === 'th' ? '\nหลักฐาน diff (ข้อความในเครื่องหมายคำพูดคงไบต์ต้นฉบับใน JSON)\n' : '\nDiff evidence (quoted text; JSON preserves original bytes)\n';
  for (const repository of repositories) {
    output += `\nRepository ${JSON.stringify(repository.path)}\n`;
    for (const comparison of repository.comparisons) {
      output += `${comparison.scope}: ${comparison.state}\n`;
      for (const file of comparison.files) {
        output += `${file.status} ${JSON.stringify(file.originalPath)} -> ${JSON.stringify(file.destinationPath)}: ${file.patch?.representation ?? 'unavailable'} (${file.patch?.state ?? 'unavailable'})\n`;
        for (const hunk of file.patch?.hunks ?? []) {
          output += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${JSON.stringify(hunk.heading)}\n`;
          for (let index = 0; index < hunk.lines.length; index++) {
            const line = hunk.lines[index]!;
            output += `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} ${JSON.stringify(line.content)}\n`;
            for (const marker of hunk.noNewlineMarkers.filter(marker => marker.afterLine === index + 1)) output += `\\ No newline at end of file (${marker.side})\n`;
          }
        }
        if (file.patch?.reasons.length) output += `  reasons: ${file.patch.reasons.join(', ')}; omitted hunks: ${file.patch.omittedHunks ?? 'unknown'}\n`;
      }
      if (comparison.patchCoverage?.truncated) output += 'Patch truncated; total bytes and omitted hunks unknown.\n';
    }
    for (const file of repository.untracked) {
      output += `Untracked filesystem ${JSON.stringify(file.path)}: ${file.content?.state ?? 'metadata-only'}${file.content?.reason ? ` (${file.content.reason})` : ''}\n`;
      if (file.content?.text !== null && file.content?.text !== undefined) output += `${JSON.stringify(file.content.text)}\n`;
    }
  }
  return output;
}
