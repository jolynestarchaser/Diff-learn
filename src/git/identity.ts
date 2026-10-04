import { createHash } from 'node:crypto';
import path from 'node:path';

export const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const relativePath = (root: string, directory: string): string => path.relative(root, directory).split(path.sep).join('/') || '.';
export const isWithin = (root: string, directory: string): boolean => {
  const relative = path.relative(root, directory);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
export const repositoryId = (key: string): string => createHash('sha256').update(JSON.stringify(['repo-v1', key])).digest('hex');
