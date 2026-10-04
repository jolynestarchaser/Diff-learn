import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { configSchema, defaultLimits, resolveLimits, type Config, type Limits } from './schema.js';

export class ScanError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitCode: 1 | 2 = 2) { super(message); }
}

export function parseConfig(text: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
    // JSON.parse accepts duplicate keys. Walk validated JSON tokens to reject them,
    // including escaped equivalent keys and nested objects, before schema validation.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? [];
    let cursor = 0;
    function walk(): void {
      const token = tokens[cursor++];
      if (token === '{') {
        const keys = new Set<string>();
        while (tokens[cursor] !== '}') {
          const key = JSON.parse(tokens[cursor++]!) as string;
          if (keys.has(key)) throw new Error(`Duplicate JSON key ${JSON.stringify(key)}`);
          keys.add(key); cursor++; walk();
          if (tokens[cursor] !== ',') break;
          cursor++;
        }
        cursor++;
      } else if (token === '[') {
        while (tokens[cursor] !== ']') {
          walk(); if (tokens[cursor] !== ',') break; cursor++;
        }
        cursor++;
      }
    }
    walk();
  } catch (error) {
    throw new ScanError('CONFIG_INVALID_JSON', error instanceof Error ? error.message : 'Invalid JSON');
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new ScanError('CONFIG_INVALID', parsed.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; '));
  return parsed.data;
}

export async function loadConfig(root: string, explicit: string | undefined): Promise<{ config: Config; configPath: string | null; limits: Limits }> {
  const configPath = explicit === undefined ? path.join(root, '.difflearn.json') : path.resolve(explicit);
  let handle;
  try {
    if (!(await stat(configPath)).isFile()) throw new ScanError('CONFIG_READ_FAILED', 'Configuration must be a regular file');
    handle = await open(configPath, 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw new ScanError('CONFIG_READ_FAILED', 'Configuration must be a regular file');
    if (info.size > 1024 * 1024) throw new ScanError('CONFIG_LIMIT', 'Configuration exceeds 1 MiB');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > 1024 * 1024) throw new ScanError('CONFIG_LIMIT', 'Configuration exceeds 1 MiB');
    const bytes = buffer.subarray(0, bytesRead);
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new ScanError('CONFIG_INVALID_JSON', 'Configuration must be UTF-8');
    const config = parseConfig(bytes.toString('utf8'));
    return { config, configPath, limits: resolveLimits(config.limits) };
  } catch (error) {
    if (explicit === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return { config: { configVersion: '1' }, configPath: null, limits: { ...defaultLimits } };
    if (error instanceof ScanError) throw error;
    throw new ScanError('CONFIG_READ_FAILED', `Cannot read configuration ${JSON.stringify(configPath)}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  } finally { await handle?.close(); }
}
