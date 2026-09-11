import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob } from '../src/lifecycle.ts';
import { approvePlan, makePlan } from '../src/domain.ts';
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

test('prepare entry point rejects untrusted workflow identity before creating context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-prepare-'));
  const script = resolve('src/worker.ts');
  const preload = join(directory, 'deny-fetch.mjs');
  writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("Unexpected network request"); };\n');
  const trustedSha = 'a'.repeat(40);
  const environment = {
    ...process.env, GITHUB_WORKSPACE: directory, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'unused',
    SDLC_BOT_LOGIN: 'sdlc[bot]', SDLC_ISSUE: '123', SDLC_JOB: '123-1', SDLC_SOURCE_SHA: trustedSha,
    SDLC_CONTROL_SHA: trustedSha, SDLC_STAGE: 'research', GITHUB_SHA: trustedSha, GITHUB_ACTOR: 'sdlc[bot]',
  };
  try {
    for (const override of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_ACTOR: 'intruder' }]) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, 'prepare'], {
        cwd: directory, env: { ...environment, ...override }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /trusted workflow revision under the controller App identity/);
      assert.doesNotMatch(result.stderr, /api\.github\.com/);
      assert.equal(result.error, undefined);
    }
    assert.throws(() => readFileSync(join(directory, '.sdlc-context.json')), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('prepare entry point loads and validates the registered job before writing context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-prepare-valid-'));
  const script = resolve('src/worker.ts');
  const preload = join(directory, 'mock-fetch.mjs');
  const sourceSha = 'a'.repeat(40);
  const state = createLifecycle(123, 'requester', 'Feature', sourceSha);
  state.plan = makePlan('Approved plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.phase = 'coding';
  state.feedback = 'Repair';
  const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
  writeFileSync(preload, `
let requests = 0;
globalThis.fetch = async (input, init) => {
  requests += 1;
  if (requests !== 1) throw new Error('Unexpected additional request');
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = input instanceof Request ? input.method : init?.method || 'GET';
  if (method !== 'GET') throw new Error('Unexpected method: ' + method);
  if (!decodeURIComponent(url.pathname).endsWith('/repos/owner/repo/contents/issues/123.json')) throw new Error('Unexpected request: ' + url);
  if (url.searchParams.get('ref') !== 'sdlc-state') throw new Error('Missing trusted state ref: ' + url);
  const state = JSON.parse(process.env.MOCK_STATE);
  const raw = JSON.stringify(state);
  return new Response(JSON.stringify({ type: 'file', sha: '${'c'.repeat(40)}', size: Buffer.byteLength(raw),
    content: Buffer.from(raw).toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
};
`);
  const execute = (name: string, stored: typeof state, overrides: Record<string, string> = {}) => {
    const workspace = join(directory, name);
    mkdirSync(workspace);
    const output = join(workspace, 'github-output.txt');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, 'prepare'], {
      cwd: workspace, encoding: 'utf8', env: {
        ...process.env, MOCK_STATE: JSON.stringify(stored), GITHUB_WORKSPACE: workspace,
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'unused',
        SDLC_BOT_LOGIN: 'sdlc[bot]', SDLC_ISSUE: '123', SDLC_JOB: job.id,
        SDLC_SOURCE_SHA: job.inputSha, SDLC_CONTROL_SHA: job.controlSha, SDLC_STAGE: job.stage,
        GITHUB_SHA: job.controlSha, GITHUB_ACTOR: 'sdlc[bot]', ...overrides,
      },
    });
    return { result, workspace, output };
  };
  try {
    const valid = execute('valid', state);
    assert.equal(valid.result.status, 0, valid.result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(valid.workspace, '.sdlc-context.json'), 'utf8')), { state, policy });
    assert.equal(readFileSync(valid.output, 'utf8'), `base_sha=${state.baseSha}\n`);

    const mismatches: [string, typeof state, Record<string, string>][] = [
      ['source', state, { SDLC_SOURCE_SHA: 'b'.repeat(40) }],
      ['stage', state, { SDLC_STAGE: 'security' }],
      ['approval', { ...state, approval: { ...state.approval!, planHash: 'd'.repeat(64) } }, {}],
    ];
    for (const [name, stored, overrides] of mismatches) {
      const rejected = execute(name, stored, overrides);
      assert.notEqual(rejected.result.status, 0);
      assert.match(rejected.result.stderr, /registered job|approved plan/);
      assert.throws(() => readFileSync(join(rejected.workspace, '.sdlc-context.json')), /ENOENT/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('collect entry point derives authority and changes from registered state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-collect-'));
  const source = join(directory, 'source');
  const output = join(directory, '.sdlc-output');
  const script = resolve('src/worker.ts');
  try {
    mkdirSync(source);
    mkdirSync(output);
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(source, 'existing.txt'), 'before');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    const state = createLifecycle(123, 'requester', 'Feature', sha);
    state.plan = makePlan('Approved plan', 0);
    state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
      authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
    state.phase = 'coding';
    state.feedback = 'Repair';
    const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
    writeFileSync(join(directory, '.sdlc-context.json'), JSON.stringify({ state, policy }));
    writeFileSync(join(source, 'feature.txt'), 'actual change');

    writeFileSync(join(output, 'report.json'), JSON.stringify({
      outcome: 'pass', summary: 'Done', jobId: '999-999', inputSha: 'b'.repeat(40),
      changes: [{ path: 'forged.txt', content: 'forged' }],
    }));
    const rejected = spawnSync(process.execPath, [script, 'collect'], {
      cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: directory }, encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.throws(() => readFileSync(join(output, 'result.json')), /ENOENT/);

    writeFileSync(join(output, 'report.json'), JSON.stringify({ outcome: 'pass', summary: 'Done' }));
    const accepted = spawnSync(process.execPath, [script, 'collect'], {
      cwd: directory, env: { ...process.env, GITHUB_WORKSPACE: directory }, encoding: 'utf8',
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')), {
      jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Done',
      changes: [{ path: 'feature.txt', content: 'actual change' }],
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
    assert.throws(() => collectChanges(directory, sha, 'code', { ...policy, maxChangeBytes: 1 }),
      /regular text files/);
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