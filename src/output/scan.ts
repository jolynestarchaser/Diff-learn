import type { discover } from '../git/discovery.js';

export type DiscoveryResult = Awaited<ReturnType<typeof discover>>;
const safe = (value: string): string => JSON.stringify(value);

export function renderScan(result: DiscoveryResult, root: string, lang: 'en' | 'th'): string {
  const heading = lang === 'th' ? 'ผลการค้นหา repositories' : 'Repository scan';
  const rows = result.repositories.map(repo => `  ${safe(repo.path)}  [${repo.kind}]  id=${repo.repositoryId}\n    base=${repo.baseConfiguration.input === null ? '(not configured; resolution deferred)' : safe(repo.baseConfiguration.input)}  source=${repo.baseConfiguration.source ?? 'none'}${repo.linkedWorktree ? '  linked-worktree' : ''}`);
  return `${heading}: ${safe(root)}\n${rows.length ? rows.join('\n') : lang === 'th' ? 'ไม่พบ repositories ภายในขอบเขตที่ค้นหา' : 'No repositories found within the searched boundary.'}\n${lang === 'th' ? 'ความครบถ้วน' : 'Completeness'}: ${result.completeness.state}; repositories=${result.repositories.length}; directories=${result.discovery.visitedDirectories}; skipped=${result.discovery.skippedCount}\n`;
}
