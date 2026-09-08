import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob } from '../src/lifecycle.ts';
import { collectChanges, prepareContext } from '../src/worker.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));

test('workers accept only registered jobs at the exact trusted and source revisions', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const job = startJob(state, 'research', '2026-09-08T12:00:00Z');
  const input = { issue: 123, job: job.id, sourceSha: job.inputSha, controlSha: job.controlSha, stage: job.stage };
  assert.doesNotThrow(() => prepareContext(state, input));
  assert.throws(() => prepareContext(state, { ...input, controlSha: 'b'.repeat(40) }), /registered/);
  assert.throws(() => prepareContext(state, { ...input, issue: 124 }), /registered/);
  state.phase = 'paused';
  assert.throws(() => prepareContext(state, input), /registered/);
});

test('collector includes edits, additions, and deletions without following symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-collector-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(directory, 'existing.txt'), 'before');
    writeFileSync(join(directory, 'removed.txt'), 'delete');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'existing.txt'), 'after');
    writeFileSync(join(directory, 'added.txt'), 'added');
    rmSync(join(directory, 'removed.txt'));
    assert.deepEqual(collectChanges(directory, sha, 'code', policy), [
      { path: 'added.txt', content: 'added' }, { path: 'existing.txt', content: 'after' },
      { path: 'removed.txt', content: null },
    ]);
    symlinkSync('/etc/hosts', join(directory, 'linked.txt'));
    assert.throws(() => collectChanges(directory, sha, 'code', policy), /regular text files/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('check-result entry point treats skipped, missing, and failed checks as failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-check-result-'));
  const script = resolve('src/worker.ts');
  try {
    const execute = (stage: string, results: Record<string, { result: string }>) => {
      execFileSync(process.execPath, [script, 'checks'], { cwd: directory, env: {
        ...process.env, SDLC_JOB: '123-1', SDLC_SOURCE_SHA: 'a'.repeat(40), SDLC_STAGE: stage,
        SDLC_CHECK_RESULTS: JSON.stringify(results), GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '1',
      } });
      return JSON.parse(readFileSync(join(directory, '.sdlc-output/result.json'), 'utf8'));
    };
    const good = { prepare: { result: 'success' }, codeql: { result: 'success' }, security: { result: 'success' } };
    assert.equal(execute('scan', good).outcome, 'pass');
    for (const result of ['skipped', 'failure', 'cancelled']) {
      assert.equal(execute('scan', { ...good, security: { result } }).outcome, 'changes_requested');
    }
    assert.equal(execute('validate', { prepare: { result: 'success' }, tests: { result: 'success' } }).outcome, 'pass');
    assert.equal(execute('validate', {}).outcome, 'changes_requested');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});