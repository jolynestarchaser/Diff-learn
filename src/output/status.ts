import type { RepositoryStatus } from '../git/collector.js';

export function renderStatus(repositories: RepositoryStatus[], root: string, completeness: string, lang: 'en' | 'th'): string {
  const lines = [lang === 'th' ? `สถานะ Git ใน ${JSON.stringify(root)}` : `Git status in ${JSON.stringify(root)}`];
  for (const repo of repositories) {
    lines.push(`\n${JSON.stringify(repo.path)} [${repo.state}] ${repo.repositoryId}`);
    if (!repo.revisions) { lines.push(`  Collection unavailable: ${repo.reasons.join(', ')}`); continue; }
    const { head, base, mergeBase } = repo.revisions;
    lines.push(`  HEAD: ${head.oid ?? '(unborn)'} (${head.state}${head.branch ? `, ${JSON.stringify(head.branch)}` : ''})`);
    lines.push(`  Base: ${base.oid ?? '(unavailable)'}; input ${JSON.stringify(base.input)}; source ${base.resolutionSource ?? 'none'}`);
    lines.push(`  Merge-base: ${mergeBase.oid ?? '(unavailable)'}${mergeBase.reason ? ` [${mergeBase.reason}]` : ''}`);
    lines.push(`  Working tree: ${!repo.workingTree?.available ? 'unavailable' : repo.workingTree.clean ? 'clean' : 'dirty'}; ${repo.untracked.length} eligible untracked; ${repo.conflicts.length} conflicts`);
    for (const entry of repo.workingTree?.entries ?? []) lines.push(`    ${entry.xy} ${JSON.stringify(entry.path)}${entry.originalPath !== null ? ` <- ${JSON.stringify(entry.originalPath)}` : ''}`);
    for (const entry of repo.untracked) lines.push(`    ?? ${JSON.stringify(entry.path)} (${entry.type}, ${entry.size ?? '?'} bytes; ${entry.contentPolicy})`);
    for (const comparison of repo.comparisons) {
      lines.push(`  ${comparison.scope === 'branch' ? 'Committed branch changes' : comparison.scope}: ${comparison.state === 'unavailable' ? 'unavailable' : `${comparison.files.length} tracked changes`} [${comparison.state}]${comparison.reasons.length ? ` (${comparison.reasons.join(', ')})` : ''}`);
      for (const file of comparison.files) lines.push(`    ${file.status}${file.similarity ?? ''} ${JSON.stringify(file.destinationPath)}${file.status === 'R' ? ` <- ${JSON.stringify(file.originalPath)}` : ''} ${file.binary ? '(binary)' : file.kind === 'gitlink' ? '(gitlink)' : `+${file.added ?? '?'} -${file.deleted ?? '?'}`}`);
    }
    lines.push(`  Snapshot: ${repo.snapshot.consistency}; ${repo.snapshot.attempts} attempt(s)`);
  }
  lines.push(`\nCompleteness: ${completeness}; ${repositories.length} repositories. A clean working tree can still have committed branch changes.`);
  return `${lines.join('\n')}\n`;
}
