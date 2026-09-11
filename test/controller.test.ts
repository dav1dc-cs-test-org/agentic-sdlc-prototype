import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Controller, RetryablePlatformError, type Comment, type Platform, type RecordState, type Run } from '../src/controller.ts';
import { lifecycleSchema, migrateLifecycle, policySchema, type Change, type Intake, type Report } from '../src/contracts.ts';
import { createLifecycle, type Job, type Lifecycle, type Task } from '../src/lifecycle.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);

class FakePlatform implements Platform {
  raw?: string;
  version?: string;
  saveFailure?: unknown;
  input = { number: 123, title: 'Feature', body: 'Implement a feature', author: 'requester', open: true, labeled: true };
  messages: Comment[] = [];
  outputs = new Map<string, string>();
  dispatched: Job[] = [];
  dispatchFailure?: unknown;
  runs = new Map<string, Run>();
  reports = new Map<number, Report>();
  reportFailure?: unknown;
  cancelled: number[] = [];
  cancelFailure?: unknown;
  changed = 0;
  published = 0;
  closedTasks = 0;
  retired: number[] = [];
  baselineSha = baseSha;
  trustedChange = false;
  disposition: 'open' | 'closed' | 'merged' = 'open';
  async issue() { return this.input; }
  async comments() { return this.messages; }
  async canWrite(actor: string) { return actor === 'maintainer'; }
  async baseline() { return { branch: 'main', sha: this.baselineSha }; }
  async trustedPathsChanged(from: string, to: string) { return from !== to && this.trustedChange; }
  // Mirrors GitHub.save/GitHub.load exactly: raw JSON on write, schema-validated on read.
  async load() {
    if (this.raw === undefined) return undefined;
    const stored = JSON.parse(this.raw);
    const state = migrateLifecycle(stored);
    return { state, version: this.version, needsMigration: stored.schemaVersion !== state.schemaVersion };
  }
  async save(record: RecordState) {
    lifecycleSchema.parse(record.state);
    if (this.saveFailure) throw this.saveFailure;
    assert.equal(record.version, this.version, 'State write conflict');
    this.raw = JSON.stringify(record.state);
    this.version = `${Number(this.version ?? 0) + 1}`;
    record.version = this.version;
    delete record.needsMigration;
  }
  get stored(): { state: Lifecycle } | undefined {
    return this.raw === undefined ? undefined : { state: lifecycleSchema.parse(JSON.parse(this.raw)) };
  }
  patch(change: (state: Lifecycle) => void): void {
    const state = lifecycleSchema.parse(JSON.parse(this.raw!));
    change(state);
    this.raw = JSON.stringify(state);
  }
  async comment(_number: number, key: string, body: string) { this.outputs.set(key, body); }
  async task(_state: Lifecycle, task: Task) { return task.id === 'first' ? 124 : 125; }
  linked = 0;
  async linkTasks() { this.linked += 1; }
  async dispatch(job: Job) {
    this.dispatched.push(structuredClone(job));
    if (this.dispatchFailure) throw this.dispatchFailure;
  }
  async findRun(job: Job) { return this.runs.get(job.id); }
  async cancelRun(runId: number) {
    this.cancelled.push(runId);
    if (this.cancelFailure) throw this.cancelFailure;
  }
  async report(run: Run) {
    if (this.reportFailure) throw this.reportFailure;
    return this.reports.get(run.id)!;
  }
  costs: { runnerMs: number; credits: number; preempted: boolean }[] = [];
  charged: number[] = [];
  async cost(run: Run) {
    this.charged.push(run.id);
    return this.costs.shift() ?? { runnerMs: 60_000, credits: 10, preempted: false };
  }
  async applyChanges(_state: Lifecycle, _job: Job, _changes: Change[]) {
    this.changed += 1;
    return this.changed.toString(16).padStart(40, '0');
  }
  async publish() { this.published += 1; return 126; }
  async pullRequest() { return this.disposition; }
  async closeTasks() { this.closedTasks += 1; }
  async retireTasks(numbers: number[]) { this.retired.push(...numbers); }
  reply(body: string, actor = 'requester') {
    this.messages.push({ id: this.messages.length + 1, body, actor, human: true, createdAt: '2026-09-08T12:00:00Z' });
  }
  finish(extra: Partial<Report> = {}, conclusion = 'success') {
    const job = this.stored!.state.job!;
    const id = this.reports.size + 1;
    this.runs.set(job.id, { id, status: 'completed', conclusion, url: `https://github.com/owner/repo/actions/runs/${id}` });
    this.reports.set(id, { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Checked successfully', changes: [], ...extra });
  }
}

function controllerProcessFixture(states: Record<string, unknown>, interruptWrite = false) {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-controller-migration-'));
  const store = join(directory, 'store.json');
  const preload = join(directory, 'mock-github.mjs');
  writeFileSync(store, JSON.stringify({ states, comments: {}, requests: [], writes: [], interruptWrite }));
  writeFileSync(preload, String.raw`
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const filename = process.env.MOCK_STORE;
const sha = state => createHash('sha1').update(JSON.stringify(state)).digest('hex');
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = input instanceof Request ? input.method : init?.method || 'GET';
  const path = decodeURIComponent(url.pathname);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const store = JSON.parse(readFileSync(filename, 'utf8'));
  store.requests.push(method + ' ' + path);
  const respond = (data, status = 200) => {
    writeFileSync(filename, JSON.stringify(store));
    const response = new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  if (url.origin !== 'https://api.github.com') return respond({ message: 'Unexpected origin' }, 500);
  if (method === 'GET' && path === '/repos/owner/repo') return respond({ default_branch: 'main' });
  if (method === 'GET' && /^\/repos\/owner\/repo\/git\/ref\/heads\/(main|sdlc-state)$/.test(path)) {
    return respond({ object: { sha: 'a'.repeat(40) } });
  }
  if (method === 'GET' && path === '/repos/owner/repo/contents/issues') {
    return respond(Object.keys(store.states).map(number => ({ name: number + '.json', type: 'file' })));
  }
  if (method === 'GET' && path === '/repos/owner/repo/issues') return respond([]);
  const record = /^\/repos\/owner\/repo\/contents\/issues\/(\d+)\.json$/.exec(path);
  if (record) {
    const number = record[1];
    const state = store.states[number];
    if (method === 'GET') {
      const content = JSON.stringify(state);
      return respond({ type: 'file', sha: sha(state), size: Buffer.byteLength(content),
        content: Buffer.from(content).toString('base64') });
    }
    if (method === 'PUT' && body.branch === 'sdlc-state') {
      if (body.sha !== sha(state)) return respond({ message: 'State write conflict' }, 409);
      store.states[number] = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      store.writes.push(method + ' ' + path);
      if (store.interruptWrite) {
        store.interruptWrite = false;
        writeFileSync(filename, JSON.stringify(store));
        throw new Error('Lost migration acknowledgement');
      }
      return respond({ content: { sha: sha(store.states[number]) } });
    }
  }
  const issue = /^\/repos\/owner\/repo\/issues\/(\d+)$/.exec(path);
  if (method === 'GET' && issue) {
    return respond({ number: Number(issue[1]), title: 'Feature', body: '',
      user: { login: 'requester' }, state: 'closed', labels: [] });
  }
  const comments = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(path);
  if (comments) {
    const number = comments[1];
    if (method === 'GET') return respond(store.comments[number] || []);
    if (method === 'POST') {
      const comment = { id: Number(number), body: body.body, user: { login: 'sdlc[bot]', type: 'Bot' },
        created_at: '2026-09-11T12:00:00Z', updated_at: '2026-09-11T12:00:00Z' };
      (store.comments[number] ||= []).push(comment);
      store.writes.push(method + ' ' + path);
      return respond(comment);
    }
  }
  return respond({ message: 'Unexpected request: ' + method + ' ' + path }, 500);
};
`);
  const eventPath = join(directory, 'event.json');
  return {
    execute: (overrides: Record<string, string> = {}, event?: unknown) => {
      if (event !== undefined) writeFileSync(eventPath, JSON.stringify(event));
      return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve('src/main.ts')], {
          cwd: process.cwd(), encoding: 'utf8', env: {
            GH_TOKEN: 'unused-fixture-token', GITHUB_REPOSITORY: 'owner/repo', SDLC_BOT_LOGIN: 'sdlc[bot]',
            GITHUB_SHA: baseSha, MOCK_STORE: store,
            ...(event === undefined ? {} : { GITHUB_EVENT_PATH: eventPath }),
            ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
            ...overrides,
          },
        });
    },
    read: () => JSON.parse(readFileSync(store, 'utf8')),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function intake(platform: FakePlatform, actor = 'maintainer'): Intake {
  return { issueNumber: platform.input.number, actor, requester: platform.input.author,
    title: platform.input.title, body: platform.input.body };
}

async function planned() {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123, intake(platform));
  platform.finish({ plan: 'Implement the feature with regression coverage.' });
  await controller.tick(123);
  return { platform, controller };
}

async function coding() {
  const context = await planned();
  context.platform.reply('/sdlc approve v1');
  await context.controller.tick(123);
  context.platform.finish({ tasks: [
    { id: 'second', title: 'Second task', description: 'Depends on first', acceptance: ['Works'], dependsOn: ['first'] },
    { id: 'first', title: 'First task', description: 'Independent', acceptance: ['Works'], dependsOn: [] },
  ] });
  await context.controller.tick(123);
  return context;
}

test('legacy waiting and terminal lifecycles are migrated once without restarting work', async () => {
  for (const phase of ['awaiting_approval', 'paused', 'pr_open', 'merged', 'cancelled'] as const) {
    const { platform, controller } = await planned();
    const state = platform.stored!.state;
    state.phase = phase;
    if (phase === 'pr_open') state.prNumber = 126;
    platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
    const version = Number(platform.version);
    const dispatched = platform.dispatched.length;
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state, { ...state, spend: {
      runs: 0, runnerMs: 0, credits: 0, nearLimit: 0, preempted: 0, historyComplete: false,
    } });
    assert.match(platform.outputs.get('status')!, /Recorded cost \(earlier costs unavailable\)/);
    assert.equal(Number(platform.version), version + 1);
    await controller.tick(123);
    assert.equal(Number(platform.version), version + 1);
    assert.equal(platform.dispatched.length, dispatched);
    assert.equal(platform.published, 0);
  }
});

test('controller persists migration before PR effects and retries a failed state write', async () => {
  const { platform, controller } = await planned();
  const state = platform.stored!.state;
  state.phase = 'pr_open';
  state.prNumber = 126;
  const legacy = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  platform.raw = legacy;
  platform.outputs.clear();
  let inspected = 0;
  platform.pullRequest = async () => { inspected += 1; return 'open'; };
  platform.saveFailure = new Error('Interrupted migration');
  await assert.rejects(controller.tick(123), /Interrupted migration/);
  assert.equal(platform.raw, legacy);
  assert.equal(inspected, 0);
  assert.equal(platform.outputs.size, 0);
  platform.saveFailure = undefined;
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(inspected, 1);
  assert.equal(platform.published, 0);
});

test('migrating a legacy plan does not authorize an untrusted approval command', async () => {
  const { platform, controller } = await planned();
  const state = platform.stored!.state;
  platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  const dispatched = platform.dispatched.length;
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  assert.equal(platform.stored!.state.approval, undefined);
  assert.deepEqual(platform.stored!.state.plan, state.plan);
  assert.equal(platform.dispatched.length, dispatched);
  assert.equal(platform.published, 0);
  assert.match(platform.outputs.get('comment:1')!, /only the requester or a repository maintainer/);
});

test('legacy migration cannot bypass the trusted-revision gate or accept an old job', async () => {
  const { platform, controller } = await coding();
  const state = platform.stored!.state;
  const job = state.job!;
  platform.raw = JSON.stringify({ ...state, schemaVersion: 1, spend: undefined });
  platform.baselineSha = 'b'.repeat(40);
  platform.trustedChange = true;
  platform.runs.set(job.id, { id: 50, status: 'in_progress', conclusion: null, url: 'https://github.com/run/50' });
  const dispatched = platform.dispatched.length;
  await controller.tick(123);
  assert.equal(platform.stored!.state.schemaVersion, 2);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.stored!.state.job, undefined);
  assert.equal(platform.stored!.state.controlSha, state.controlSha);
  assert.deepEqual(platform.stored!.state.approval, state.approval);
  assert.deepEqual(platform.cancelled, [50]);
  assert.match(platform.stored!.state.error!, /trusted revision changed/);
  platform.runs.set(job.id, { id: 50, status: 'completed', conclusion: 'success', url: 'https://github.com/run/50' });
  platform.reports.set(50, { jobId: job.id, inputSha: job.inputSha, outcome: 'pass', summary: 'Late result',
    changes: [{ path: 'feature.txt', content: 'Must not be applied' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, dispatched);
  assert.equal(platform.changed, 0);
  assert.equal(platform.published, 0);
  assert.equal(platform.charged.includes(50), false);
});

test('controller entry point isolates corrupt state and migrates closed issues idempotently', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: null };
  const valid = { ...createLifecycle(2, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const current = { ...createLifecycle(3, 'requester', 'Feature', baseSha), phase: 'merged' };
  const fixture = controllerProcessFixture({ 1: legacy, 2: valid, 3: current });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = fixture.execute();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Issue #1:/);
      assert.match(result.stderr, /spend/);
      assert.doesNotMatch(result.stderr, /Unexpected|Issue #[23]:/);
      assert.match(result.stdout, /Reconciled issue #2/);
      assert.match(result.stdout, /Reconciled issue #3/);
      const saved = fixture.read();
      assert.deepEqual(saved.states['1'], legacy);
      assert.deepEqual(saved.states['2'], migrateLifecycle(JSON.parse(JSON.stringify(valid))));
      assert.deepEqual(saved.states['3'], current);
      assert.deepEqual(saved.writes, [
        'PUT /repos/owner/repo/contents/issues/2.json',
        'POST /repos/owner/repo/issues/2/comments', 'POST /repos/owner/repo/issues/3/comments',
      ]);
      assert.match(saved.comments['2'][0].body, /earlier costs unavailable/);
    }
    const selected = fixture.execute({ SDLC_ISSUE: '2' });
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stdout.trim(), 'Reconciled issue #2');
    assert.equal(fixture.read().writes.length, 3);
  } finally { fixture.dispose(); }
});

test('controller entry point recovers a committed migration after losing its acknowledgement', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const fixture = controllerProcessFixture({ 1: legacy }, true);
  try {
    const interrupted = fixture.execute();
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, /Lost migration acknowledgement/);
    const saved = fixture.read();
    assert.deepEqual(saved.states['1'], migrateLifecycle(JSON.parse(JSON.stringify(legacy))));
    assert.deepEqual(saved.writes, ['PUT /repos/owner/repo/contents/issues/1.json']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recovered = fixture.execute();
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(fixture.read().states, saved.states);
      assert.deepEqual(fixture.read().writes, [
        'PUT /repos/owner/repo/contents/issues/1.json', 'POST /repos/owner/repo/issues/1/comments',
      ]);
    }
  } finally { fixture.dispose(); }
});

test('controller entry point rejects missing credentials and stale code before migration', () => {
  const legacy = { ...createLifecycle(1, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined };
  const fixture = controllerProcessFixture({ 1: legacy });
  try {
    const missing = fixture.execute({ GH_TOKEN: '' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /scoped GitHub App token is required/);
    assert.deepEqual(fixture.read().requests, []);
    const stale = fixture.execute({ GITHUB_SHA: 'b'.repeat(40) });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Controller revision is stale/);
    assert.deepEqual(fixture.read().requests, ['GET /repos/owner/repo', 'GET /repos/owner/repo/git/ref/heads/main']);
    assert.deepEqual(fixture.read().writes, []);
    assert.deepEqual(fixture.read().states, JSON.parse(JSON.stringify({ 1: legacy })));
  } finally { fixture.dispose(); }
});

test('controller entry point selects only the issue named by each supported event', () => {
  const states = Object.fromEntries([1, 2].map(number => [number, {
    ...createLifecycle(number, 'requester', 'Feature', baseSha), phase: 'cancelled', schemaVersion: 1, spend: undefined,
  }]));
  for (const event of [
    { workflow_run: { display_title: 'SDLC 2-7' } },
    { issue: { number: 2 } },
    { action: 'labeled', label: { name: policy.label }, sender: { login: 'maintainer', type: 'User' },
      issue: { number: 2, title: 'Feature', body: '', user: { login: 'requester' } } },
  ]) {
    const fixture = controllerProcessFixture(states);
    try {
      const result = fixture.execute({}, event);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'Reconciled issue #2');
      assert.deepEqual(fixture.read().states['1'], JSON.parse(JSON.stringify(states['1'])));
      assert.equal(fixture.read().states['2'].schemaVersion, 2);
      assert.deepEqual(fixture.read().writes, [
        'PUT /repos/owner/repo/contents/issues/2.json', 'POST /repos/owner/repo/issues/2/comments',
      ]);
    } finally { fixture.dispose(); }
  }
});

test('controller entry point ignores PR events before loading or migrating state', () => {
  const fixture = controllerProcessFixture({
    1: { ...createLifecycle(1, 'requester', 'Feature', baseSha), schemaVersion: 1, spend: undefined },
  });
  try {
    const result = fixture.execute({}, { issue: { number: 1, pull_request: {} } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fixture.read().requests, ['GET /repos/owner/repo', 'GET /repos/owner/repo/git/ref/heads/main']);
    assert.deepEqual(fixture.read().writes, []);
    assert.equal(fixture.read().states['1'].schemaVersion, 1);
  } finally { fixture.dispose(); }
});

test('controller entry point rejects invalid issue selections without touching saved records', () => {
  const fixture = controllerProcessFixture({
    1: { ...createLifecycle(1, 'requester', 'Feature', baseSha), schemaVersion: 1, spend: undefined },
  });
  try {
    for (const issue of ['0', '-1', 'not-a-number', '9007199254740992']) {
      const result = fixture.execute({ SDLC_ISSUE: issue });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid issue number/);
      assert.deepEqual(fixture.read().writes, []);
      assert.equal(fixture.read().states['1'].schemaVersion, 1);
    }
  } finally { fixture.dispose(); }
});

test('label intake is authorized and duplicate events do not duplicate dispatch', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123);
  assert.equal(platform.stored, undefined);
  await controller.tick(123, intake(platform, 'stranger'));
  assert.equal(platform.stored, undefined);
  await controller.tick(123, intake(platform));
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
});

test('an issue edit after labeling cannot replace the authorized intake snapshot', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  const authorized = intake(platform);
  platform.input.body = 'Substituted scope';
  await controller.tick(123, authorized);
  assert.equal(platform.stored!.state.request, 'Feature\n\nImplement a feature');
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, 0);
});

test('research stops for approval and only explicit authorized approval resumes', async () => {
  const { platform, controller } = await planned();
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'decompose');
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 2);
});

test('revision invalidates approval and rejects approval of the old version', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc revise Prefer a smaller implementation');
  await controller.tick(123);
  platform.finish({ plan: 'A smaller revised plan.' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.plan!.version, 2);
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  assert.match(platform.outputs.get('comment:2')!, /stale/);
});

test('complete lifecycle rescans test changes and publishes exactly one final PR', async () => {
  const { platform, controller } = await coding();
  assert.equal(platform.stored!.state.job!.taskId, 'first');
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.taskId, 'second');
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both tasks' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'test');
  platform.finish({ changes: [{ path: 'test/feature.test.ts', content: 'A real regression test' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'validate', 'document', 'review']) {
    assert.equal(platform.published, 0);
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.published, 1);
  assert.equal(platform.stored!.state.phase, 'pr_open');
  await controller.tick(123);
  assert.equal(platform.published, 1);
  platform.disposition = 'merged';
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'merged');
  assert.equal(platform.closedTasks, 1);
  await controller.tick(123);
  assert.equal(platform.closedTasks, 1);
});

test('replanning retires old tasks and checkpoints the new scope before starting another worker', async () => {
  const { platform, controller } = await coding();
  platform.reply('/sdlc revise Use the smaller alternative');
  await controller.tick(123);
  assert.deepEqual(platform.retired.sort(), [124, 125]);
  assert.equal(platform.stored!.state.approval, undefined);
  assert.deepEqual(platform.stored!.state.tasks, []);
  assert.equal(platform.stored!.state.branch, 'agentic/epic-123-v2');
  assert.equal(platform.stored!.state.job!.stage, 'research');
});

test('security findings return to coding with a bounded repair loop', async () => {
  const { platform, controller } = await coding();
  platform.finish(); await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Feature' }] }); await controller.tick(123);
  for (let attempt = 0; attempt <= policy.maxRepairs; attempt += 1) {
    platform.finish({ outcome: 'changes_requested', summary: 'Fix the vulnerable dependency' }, 'failure');
    await controller.tick(123);
    if (attempt < policy.maxRepairs) {
      assert.equal(platform.stored!.state.job!.stage, 'code');
      platform.finish(); await controller.tick(123);
    }
  }
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.published, 0);
});

test('late review findings invalidate evidence and force every gate after a no-change repair', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Complete' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'test', 'validate', 'document']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'review');
  assert.deepEqual(platform.stored!.state.evidence.map(item => item.stage),
    ['scan', 'security', 'test', 'validate', 'document']);
  platform.finish({ outcome: 'changes_requested', summary: 'Repair the late review finding' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.stage, 'code');
  assert.deepEqual(platform.stored!.state.evidence, []);
  assert.equal(platform.published, 0);

  platform.finish();
  await controller.tick(123);
  const rerun: string[] = [];
  for (const stage of ['scan', 'security', 'test', 'validate', 'document', 'review']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    rerun.push(platform.stored!.state.job!.stage);
    platform.finish();
    await controller.tick(123);
    if (stage !== 'review') assert.equal(platform.published, 0);
  }
  assert.deepEqual(rerun, ['scan', 'security', 'test', 'validate', 'document', 'review']);
  assert.equal(platform.published, 1);
});

test('documentation changes invalidate gate evidence and re-verify before review', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both tasks' }] });
  await controller.tick(123);
  for (const stage of ['scan', 'security', 'test', 'validate']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'document');
  platform.finish({ changes: [{ path: 'docs/architecture.md', content: 'Documented behaviour' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'scanning');
  assert.deepEqual(platform.stored!.state.evidence.map(item => item.stage), ['document']);
  for (const stage of ['scan', 'security', 'test', 'validate', 'document']) {
    assert.equal(platform.stored!.state.job!.stage, stage);
    assert.equal(platform.published, 0);
    platform.finish();
    await controller.tick(123);
  }
  assert.equal(platform.stored!.state.job!.stage, 'review');
  platform.finish();
  await controller.tick(123);
  assert.equal(platform.published, 1);
});

test('every completed run is charged once, including one the credit limiter pre-empted', async () => {
  const { platform, controller } = await coding();
  const before = platform.stored!.state.spend;
  assert.ok(before.runs > 0, 'earlier stages must already be charged');

  platform.costs = [{ runnerMs: 120_000, credits: 190, preempted: false }];
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.nearLimit, 1);
  assert.equal(platform.stored!.state.spend.preempted, 0);

  platform.costs = [{ runnerMs: 30_000, credits: 205, preempted: true }];
  platform.finish({ changes: [{ path: 'feature.txt', content: 'Both' }] });
  await controller.tick(123);
  const spend = platform.stored!.state.spend;
  assert.equal(spend.preempted, 1);
  assert.equal(spend.nearLimit, 1, 'a pre-empted run must not also count as near the limit');
  assert.equal(spend.credits, before.credits + 395);
  assert.equal(spend.runnerMs, before.runnerMs + 150_000);

  const charged = platform.charged.length;
  await controller.tick(123);
  assert.equal(platform.charged.length, charged, 'a run is charged once, not once per tick');
  assert.doesNotMatch(platform.outputs.get('status')!, /earlier costs unavailable/);
});

test('migrated in-flight jobs preserve cost history and charge each run only once across retries', async () => {
  for (const measured of [false, true]) {
    const { platform, controller } = await coding();
    const charged = platform.charged.length;
    platform.costs = [{ runnerMs: 45_000, credits: 33, preempted: false }];
    platform.finish();
    platform.reportFailure = new RetryablePlatformError('Artifact not yet available');
    if (measured) await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    const state = platform.stored!.state;
    platform.raw = JSON.stringify({ ...state, schemaVersion: 1,
      spend: measured ? { ...state.spend, historyComplete: undefined } : undefined });
    const expected = measured ? state.spend : {
      runs: 1, runnerMs: 45_000, credits: 33, nearLimit: 0, preempted: 0, historyComplete: false,
    };
    await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    await assert.rejects(controller.tick(123), error => error === platform.reportFailure);
    assert.deepEqual(platform.stored!.state.spend, expected);
    assert.equal(platform.charged.length, charged + 1);
    assert.equal(platform.outputs.get('status')!.includes('earlier costs unavailable'), !measured);
    platform.reportFailure = undefined;
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state.spend, expected);
    assert.equal(platform.charged.length, charged + 1);
    platform.reply('/sdlc revise Prefer a smaller change');
    await controller.tick(123);
    assert.deepEqual(platform.stored!.state.spend, expected);
  }
});

test('a rejected result still consumes budget', async () => {
  const { platform, controller } = await coding();
  const before = platform.stored!.state.spend.credits;
  platform.costs = [{ runnerMs: 45_000, credits: 33, preempted: false }];
  platform.finish({ jobId: '123-999' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.spend.credits, before + 33);
});

test('pause discards in-flight results; only a maintainer can resume', async () => {
  const { platform, controller } = await coding();
  const job = platform.stored!.state.job!;
  platform.runs.set(job.id, { id: 20, status: 'in_progress', conclusion: null, url: 'https://github.com/run/20' });
  platform.reply('/sdlc pause');
  await controller.tick(123);
  assert.equal(platform.stored!.state.job, undefined);
  assert.deepEqual(platform.cancelled, [20]);
  platform.reply('/sdlc resume'); await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'paused');
  platform.reply('/sdlc resume', 'maintainer'); await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, job.id);
});

test('issue edits and trusted revision drift stop execution until replanning', async () => {
  const first = await coding();
  first.platform.input.body = 'Changed scope';
  await first.controller.tick(123);
  assert.equal(first.platform.stored!.state.phase, 'blocked');
  const second = await coding();
  second.platform.baselineSha = 'f'.repeat(40);
  second.platform.trustedChange = true;
  await second.controller.tick(123);
  assert.equal(second.platform.stored!.state.phase, 'blocked');
});

test('default branch movement outside trusted paths is adopted instead of blocking', async () => {
  const { platform, controller } = await coding();
  const moved = 'f'.repeat(40);
  platform.baselineSha = moved;
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  const state = platform.stored!.state;
  assert.notEqual(state.phase, 'blocked');
  assert.equal(state.controlSha, moved);
  assert.equal(state.job!.controlSha, moved);
});

test('approval pins the plan to the revision it is approved against', async () => {
  const moved = 'f'.repeat(40);
  const adopted = await planned();
  adopted.platform.baselineSha = moved;
  adopted.platform.reply('/sdlc approve v1');
  await adopted.controller.tick(123);
  const state = adopted.platform.stored!.state;
  assert.equal(state.phase, 'decomposing');
  assert.equal(state.baseSha, moved);
  assert.equal(state.headSha, moved);
  assert.equal(state.controlSha, moved);

  const rejected = await planned();
  rejected.platform.baselineSha = moved;
  rejected.platform.trustedChange = true;
  rejected.platform.reply('/sdlc approve v1');
  await rejected.controller.tick(123);
  assert.equal(rejected.platform.stored!.state.phase, 'awaiting_approval');
  assert.match([...rejected.platform.outputs.values()].join('\n'), /trusted revision changed/);
});

test('untrusted worker output cannot publish policy changes or skip stages', async () => {
  const { platform, controller } = await coding();
  platform.finish({ changes: [{ path: '.github/workflows/ci.yml', content: 'skip tests' }] });
  await controller.tick(123);
  assert.equal(platform.changed, 0);
  assert.equal(platform.stored!.state.job!.stage, 'code');
  platform.finish({ jobId: '123-999' }); await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
});

test('cancelling or removing the intake label stops future work', async () => {
  const { platform, controller } = await coding();
  platform.input.labeled = false;
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'cancelled');
  assert.equal(platform.stored!.state.job, undefined);
});

test('job budget prevents an endless run even after successful agents', async () => {
  const { platform } = await planned();
  platform.reply('/sdlc approve v1');
  await new Controller(platform, { ...policy, maxJobs: 1 }).tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
});

test('closing the feature PR persists cancellation without marking tasks complete', async () => {
  const { platform, controller } = await planned();
  platform.patch(state => { state.phase = 'pr_open'; state.prNumber = 126; });
  platform.disposition = 'closed';
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'cancelled');
  assert.equal(platform.closedTasks, 0);
  assert.match(platform.outputs.get('status')!, /cancelled/);
});

test('lost dispatches reuse their job identity and stop after bounded attempts', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  const first = platform.stored!.state.job!.id;
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 2);
  assert.equal(platform.dispatched[1]!.id, first);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, first);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  time = new Date(time.getTime() + policy.dispatchGraceMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'blocked');
  assert.equal(platform.dispatched.length, 4);
});

test('a lost dispatch response recovers the remote run without dispatching again', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  const failure = Object.assign(new Error('Dispatch response lost'), { status: 503 });
  platform.dispatchFailure = failure;
  await assert.rejects(controller.tick(123, intake(platform)), error => error === failure);
  const job = platform.stored!.state.job!;
  assert.ok(job.dispatchedAt);
  assert.equal(platform.dispatched.length, 1);

  platform.dispatchFailure = undefined;
  platform.runs.set(job.id, { id: 42, status: 'in_progress', conclusion: null,
    url: 'https://github.com/owner/repo/actions/runs/42' });
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
  assert.equal(platform.stored!.state.job!.id, job.id);
  assert.equal(platform.stored!.state.job!.runId, 42);
});

test('timed-out workers are cancelled and replaced within the infrastructure budget', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  const first = platform.stored!.state.job!.id;
  platform.runs.set(first, { id: 20, status: 'in_progress', conclusion: null, url: 'https://github.com/run/20' });
  time = new Date(time.getTime() + policy.jobTimeoutMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.deepEqual(platform.cancelled, [20]);
  assert.notEqual(platform.stored!.state.job!.id, first);
  assert.equal(platform.stored!.state.failures, 1);
});

test('failed cancellation cannot revive a durably interrupted job', async () => {
  const { platform, controller } = await coding();
  const job = platform.stored!.state.job!;
  platform.runs.set(job.id, { id: 20, status: 'in_progress', conclusion: null,
    url: 'https://github.com/owner/repo/actions/runs/20' });
  const failure = Object.assign(new Error('Cancellation unavailable'), { status: 503 });
  platform.cancelFailure = failure;
  platform.reply('/sdlc pause');
  await assert.rejects(controller.tick(123), error => error === failure);
  assert.equal(platform.stored!.state.phase, 'paused');
  assert.equal(platform.stored!.state.job, undefined);
  assert.deepEqual(platform.cancelled, [20]);

  platform.cancelFailure = undefined;
  platform.runs.set(job.id, { id: 20, status: 'completed', conclusion: 'success',
    url: 'https://github.com/owner/repo/actions/runs/20' });
  const dispatches = platform.dispatched.length;
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'paused');
  assert.equal(platform.stored!.state.job, undefined);
  assert.equal(platform.dispatched.length, dispatches);
});

test('transient artifact errors preserve the completed job for a later retry', async () => {
  const failures = [
    new RetryablePlatformError('Artifact not visible yet'),
    Object.assign(new Error('Artifact not ready'), { status: 404 }),
    Object.assign(new Error('Request timeout'), { status: 408 }),
    Object.assign(new Error('Rate limited'), { status: 429 }),
    Object.assign(new Error('Secondary rate limit'), { status: 403,
      response: { headers: { 'retry-after': '60' } } }),
    Object.assign(new Error('Artifact service unavailable'), { status: 503 }),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
  ];
  for (const failure of failures) {
    const platform = new FakePlatform();
    const controller = new Controller(platform, policy);
    await controller.tick(123, intake(platform));
    platform.finish({ plan: 'Implement the feature.' });
    const jobId = platform.stored!.state.job!.id;
    platform.reportFailure = failure;
    await assert.rejects(controller.tick(123), error => error === failure);
    assert.equal(platform.stored!.state.job!.id, jobId);
    assert.equal(platform.stored!.state.failures, 0);
    platform.reportFailure = undefined;
    await controller.tick(123);
    assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  }
});

test('persistent artifact errors consume one infrastructure failure after the job timeout', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123, intake(platform));
  platform.finish({ plan: 'Implement the feature.' });
  const jobId = platform.stored!.state.job!.id;
  platform.reportFailure = Object.assign(new Error('Artifact service unavailable'), { status: 503 });
  time = new Date(time.getTime() + policy.jobTimeoutMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.notEqual(platform.stored!.state.job!.id, jobId);
  assert.equal(platform.stored!.state.failures, 1);
});

test('surrounding whitespace in the issue and plan survives persistence', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  platform.input.body = 'Implement a feature\n';
  await controller.tick(123, intake(platform));
  platform.finish({ plan: '## Plan\n\nImplement the feature with regression coverage.\n' });
  await controller.tick(123);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
  platform.reply('/sdlc approve v1');
  await controller.tick(123);
  assert.equal(platform.outputs.get('comment:1'), undefined);
  assert.equal(platform.stored!.state.phase, 'decomposing');
});

test('rejected commands always explain themselves to the commenter', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc approve v1', 'stranger');
  await controller.tick(123);
  assert.match(platform.outputs.get('comment:1')!, /only the requester or a repository maintainer/);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
});

test('an open feature PR rejects further commands instead of ignoring them', async () => {
  const { platform, controller } = await planned();
  platform.patch(state => { state.phase = 'pr_open'; state.prNumber = 126; });
  platform.reply('/sdlc cancel');
  await controller.tick(123);
  assert.match(platform.outputs.get('comment:1')!, /pull request #126 is open/);
  assert.match(platform.outputs.get('status')!, /no longer accepts/);
  assert.equal(platform.stored!.state.phase, 'pr_open');
});

test('processed command events do not accumulate beyond the surviving comments', async () => {
  const { platform, controller } = await planned();
  platform.reply('/sdlc pause');
  await controller.tick(123);
  assert.deepEqual(platform.stored!.state.processedEvents, ['comment:1']);
  platform.messages = [{ id: 7, body: '/sdlc resume', actor: 'maintainer', human: true, createdAt: '2026-09-08T12:00:00Z' }];
  await controller.tick(123);
  assert.deepEqual(platform.stored!.state.processedEvents, ['comment:7']);
  assert.equal(platform.stored!.state.phase, 'awaiting_approval');
});

test('task issues are linked once rather than on every reconciliation', async () => {
  const { platform, controller } = await coding();
  assert.equal(platform.linked, 1);
  assert.equal(platform.stored!.state.tasksLinked, true);
  platform.finish({ changes: [{ path: 'feature.txt', content: 'First' }] });
  await controller.tick(123);
  assert.equal(platform.stored!.state.job!.taskId, 'second');
  assert.equal(platform.linked, 1);
});