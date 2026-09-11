import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lifecycleSchema, migrateLifecycle, parseIntakeEvent, policySchema, reportSchema } from '../src/contracts.ts';
import { validateChanges } from '../src/changes.ts';
import { approvePlan, digest, makePlan } from '../src/domain.ts';
import { createLifecycle } from '../src/lifecycle.ts';

export const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));

test('state and worker contracts reject unexpected authority fields', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  assert.deepEqual(lifecycleSchema.parse(state), state);
  assert.throws(() => lifecycleSchema.parse({ ...state, bypass: true }));
  assert.throws(() => reportSchema.parse({ jobId: '123-1', inputSha: 'main', outcome: 'pass', summary: 'Done' }));
  assert.throws(() => reportSchema.parse({ jobId: '123-1', inputSha: 'a'.repeat(40),
    outcome: 'pass', summary: 'Done', approved: true }));
});

test('validation never rewrites the text that plan hashes are computed over', () => {
  const state = createLifecycle(123, 'requester', 'Title\n\nBody\n', 'a'.repeat(40));
  state.plan = makePlan('## Plan\n\nDo the work.\n', 0);
  state.phase = 'awaiting_approval';
  const restored = lifecycleSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  assert.equal(restored.plan!.hash, digest({ version: restored.plan!.version, body: restored.plan!.body }));
  assert.doesNotThrow(() => approvePlan({ phase: restored.phase, plan: restored.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' }));
  assert.throws(() => lifecycleSchema.parse({ ...state, request: '   ' }));
});

test('legacy state without cost history migrates without changing lifecycle authority', () => {
  const state = createLifecycle(123, 'requester', 'Title\n\nBody\n', 'a'.repeat(40));
  state.plan = makePlan('## Plan\n\nKeep the exact approved text.\n', 0);
  state.approval = { actor: 'requester', commentId: 12, planHash: state.plan.hash, at: '2026-09-08T12:00:00Z' };
  state.phase = 'pr_open';
  state.prNumber = 456;
  state.sequence = 4;
  state.tasks = [{ id: 'feature', title: 'Feature', description: 'Implement the feature',
    acceptance: ['Tests pass'], dependsOn: [], issueNumber: 124, completed: true }];
  state.evidence = [{ stage: 'review', sha: state.headSha, jobId: '123-4', runId: 99, summary: 'Reviewed\n' }];
  state.processedEvents = ['comment:12'];
  const legacy = JSON.parse(JSON.stringify({ ...state, schemaVersion: 1, spend: undefined }));
  const before = JSON.stringify(legacy);
  const migrated = migrateLifecycle(legacy);
  assert.deepEqual(migrated, { ...state, spend: { ...state.spend, historyComplete: false } });
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(lifecycleSchema.parse(migrated), migrated);
  assert.deepEqual(migrateLifecycle(JSON.parse(JSON.stringify(migrated))), migrated);
});

test('legacy measured costs and current state survive migration unchanged', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const totals = { runs: 4, runnerMs: 234_000, credits: 312.5, nearLimit: 1, preempted: 1 };
  const migrated = migrateLifecycle({ ...state, schemaVersion: 1, spend: totals });
  assert.deepEqual(migrated, { ...state, spend: { ...totals, historyComplete: true } });
  assert.deepEqual(migrateLifecycle(state), state);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.spend.historyComplete, true);
});

test('migration rejects malformed costs, unknown versions, and unexpected authority', () => {
  const state = createLifecycle(123, 'requester', 'Feature', 'a'.repeat(40));
  const legacy = { ...state, schemaVersion: 1, spend: undefined };
  for (const input of [
    { ...legacy, spend: null },
    { ...legacy, spend: {} },
    { ...legacy, spend: [] },
    { ...legacy, spend: { runs: -1, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0 } },
    { ...legacy, spend: { runs: 1, runnerMs: 0, credits: 0, nearLimit: 0 } },
    { ...legacy, spend: { runs: 1, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, bypass: true } },
    { ...legacy, bypass: true },
    { ...legacy, request: '   ' },
    { ...legacy, schemaVersion: '1' },
    { ...state, schemaVersion: 3 },
    { ...state, schemaVersion: undefined },
    { ...state, spend: undefined },
    { ...state, spend: { ...state.spend, historyComplete: undefined } },
    { ...state, spend: { ...state.spend, historyComplete: 'false' } },
    { ...state, spend: { ...state.spend, runs: 0.5 } },
    { ...state, spend: { ...state.spend, credits: '0' } },
    { ...state, spend: { ...state.spend, credits: Infinity } },
    { ...state, spend: { ...state.spend, credits: NaN } },
    { ...state, spend: { ...state.spend, runnerMs: -1 } },
  ]) assert.throws(() => migrateLifecycle(input));
  assert.throws(() => lifecycleSchema.parse(legacy));
});

test('intake is bound to an immutable human label-event snapshot', () => {
  const event = {
    action: 'labeled', label: { name: policy.label }, sender: { login: 'maintainer', type: 'User' },
    issue: { number: 123, title: 'Feature', body: 'Original scope', user: { login: 'requester' } },
  };
  assert.deepEqual(parseIntakeEvent(event, policy.label), {
    issueNumber: 123, actor: 'maintainer', requester: 'requester', title: 'Feature', body: 'Original scope',
  });
  assert.equal(parseIntakeEvent({ ...event, action: 'edited' }, policy.label), undefined);
  assert.equal(parseIntakeEvent({ ...event, label: { name: 'other' } }, policy.label), undefined);
  assert.equal(parseIntakeEvent({ ...event, sender: { login: 'app[bot]', type: 'Bot' } }, policy.label), undefined);
});

test('publisher rejects traversal, protected configuration, and case collisions', () => {
  for (const path of ['../escape', '/tmp/escape', 'foo/../bar', '.git/config', 'foo/.GIT/config',
    '.github/workflows/ci.yml', '.GitHub/workflows/ci.yml', 'src/controller.ts',
    '.npmrc', 'nested/.npmrc', 'package.json', 'nested/package.json', 'package-lock.json',
    'AGENTS.md', 'src/AGENTS.md', 'file\\name', 'file\nname']) {
    assert.throws(() => validateChanges([{ path, content: 'unsafe' }], 'code', policy), Error, path);
  }
  assert.throws(() => validateChanges([{ path: 'README.md', content: '' },
    { path: 'readme.md', content: '' }], 'code', policy), /colliding/);
  assert.throws(() => validateChanges([{ path: 'Dir/first.txt', content: '' },
    { path: 'dir/second.txt', content: '' }], 'code', policy), /colliding/);
  for (const changes of [
    [{ path: 'Foo', content: '' }, { path: 'foo/bar.ts', content: '' }],
    [{ path: 'foo/bar.ts', content: '' }, { path: 'Foo', content: '' }],
  ]) assert.throws(() => validateChanges(changes, 'code', policy), /Conflicting/);
});

test('stage permissions and output budgets are enforced by code', () => {
  assert.doesNotThrow(() => validateChanges([{ path: 'test/new.test.ts', content: 'test' }], 'test', policy));
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'text' }], 'test', policy), /only change tests/);
  assert.doesNotThrow(() => validateChanges([{ path: 'README.md', content: 'text' },
    { path: 'docs/architecture.md', content: 'text' }, { path: 'docs/adr/0001-choice.md', content: 'text' }],
    'document', policy));
  for (const path of ['src/feature/clock.ts', 'test/new.test.ts', 'notes.md'])
    assert.throws(() => validateChanges([{ path, content: 'text' }], 'document', policy), /only change documentation/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'text' }], 'security', policy), /Read-only/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: '\0' }], 'code', policy), /Binary/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: 'too much' }], 'code',
    { ...policy, maxChangeBytes: 1 }), /size/);
  assert.throws(() => validateChanges([{ path: 'README.md', content: '' }], 'code',
    { ...policy, maxFiles: 0 }), /file budget/);
});