import { z } from 'zod';

export const defaultLimits = {
  maxDepth: 8, maxDirectories: 50_000, maxRepositories: 128, concurrency: 4,
  gitTimeoutMs: 30_000, repoTimeoutMs: 120_000, maxMetadataBytes: 16 * 1024 * 1024,
  maxFiles: 10_000, maxHunks: 20_000, maxFileBytes: 2 * 1024 * 1024,
  maxPatchBytes: 16 * 1024 * 1024, maxBundleBytes: 64 * 1024 * 1024,
  maxSnapshotBytes: 256 * 1024 * 1024, maxWorkspaceSnapshotBytes: 1024 * 1024 * 1024,
};

export function isRelativePath(value: string): boolean {
  return value === '.' || (value.length > 0 && !/[\\\u0000:*?]/u.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
}
const relativePath = z.string().refine(isRelativePath, 'Expected a literal workspace-relative / path without traversal');
const nonempty = z.string().min(1).refine(value => !value.includes('\0'), 'NUL is not allowed');
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limits = z.strictObject({
  maxDepth: z.number().int().min(0).max(1024).optional(),
  maxDirectories: positive.max(1_000_000).optional(), maxRepositories: positive.max(10_000).optional(),
  concurrency: positive.max(32).optional(), gitTimeoutMs: positive.max(600_000).optional(),
  repoTimeoutMs: positive.max(3_600_000).optional(), maxMetadataBytes: positive.optional(),
  maxFiles: positive.optional(), maxHunks: positive.optional(), maxFileBytes: positive.optional(),
  maxPatchBytes: positive.optional(), maxBundleBytes: positive.min(65_536).optional(),
  maxSnapshotBytes: positive.optional(), maxWorkspaceSnapshotBytes: positive.optional(),
});

export const configSchema = z.strictObject({
  configVersion: z.literal('1'), base: nonempty.optional(), lang: z.enum(['en', 'th']).optional(),
  repositories: z.array(z.strictObject({ path: relativePath, key: nonempty.optional(), base: nonempty.optional() })).optional(),
  excludeDirectories: z.array(nonempty.refine(value => !/[\\/*?:]/u.test(value) && value !== '.' && value !== '..', 'Expected a literal directory name')).optional(),
  excludePaths: z.array(relativePath.refine(value => value !== '.', 'Cannot exclude the scan root')).optional(),
  limits: limits.optional(),
}).superRefine((config, context) => {
  const paths = new Set<string>();
  const keys = new Set<string>();
  for (const [index, repo] of (config.repositories ?? []).entries()) {
    const key = repo.key ?? repo.path;
    if (paths.has(repo.path) || keys.has(key)) context.addIssue({ code: 'custom', path: ['repositories', index], message: 'Duplicate repository path or logical key' });
    paths.add(repo.path); keys.add(key);
  }
});
export type Config = z.infer<typeof configSchema>;
export type Limits = typeof defaultLimits;
export function resolveLimits(overrides: Config['limits']): Limits {
  const result = { ...defaultLimits };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== undefined) result[key as keyof Limits] = value;
  }
  return result;
}
