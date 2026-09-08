import { posix } from 'node:path';
import type { Change, Policy } from './contracts.ts';
import type { Stage } from './lifecycle.ts';

export function isTestPath(path: string, policy: Policy): boolean {
  return policy.testPaths.some(pattern => posix.matchesGlob(path, pattern));
}

export function validateChanges(changes: Change[], stage: Stage, policy: Policy): void {
  if (!['code', 'test'].includes(stage) && changes.length) throw new Error('Read-only stage proposed changes');
  if (changes.length > policy.maxFiles) throw new Error('Changed-file budget exceeded');
  const seen = new Set<string>();
  let bytes = 0;
  for (const change of changes) {
    const path = change.path;
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error(`Unsafe file path: ${path}`);
    }
    const normalized = path.toLowerCase();
    if (seen.has(normalized)) throw new Error('Duplicate or case-colliding file paths');
    seen.add(normalized);
    if (normalized.startsWith('.github/') || normalized.startsWith('.sdlc') ||
        /(^|\/)agents\.md$/.test(normalized) ||
        policy.protectedPaths.some(pattern => posix.matchesGlob(normalized, pattern.toLowerCase()))) {
      throw new Error(`Protected file: ${path}`);
    }
    if (stage === 'test' && !isTestPath(path, policy)) throw new Error('Testing agent may only change tests');
    if (change.content?.includes('\0')) throw new Error('Binary files are not supported');
    bytes += Buffer.byteLength(change.content ?? '', 'utf8');
    if (bytes > policy.maxChangeBytes) throw new Error('Change-size budget exceeded');
  }
}