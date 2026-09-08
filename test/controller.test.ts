import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Controller, type Comment, type Platform, type RecordState, type Run } from '../src/controller.ts';
import { policySchema, type Change, type Report } from '../src/contracts.ts';
import type { Job, Lifecycle, Task } from '../src/lifecycle.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);

class FakePlatform implements Platform {
  stored?: RecordState;
  input = { number: 123, title: 'Feature', body: 'Implement a feature', author: 'requester', open: true, labeled: true };
  messages: Comment[] = [];
  outputs = new Map<string, string>();
  dispatched: Job[] = [];
  runs = new Map<string, Run>();
  reports = new Map<number, Report>();
  cancelled: number[] = [];
  changed = 0;
  published = 0;
  closedTasks = 0;
  retired: number[] = [];
  baselineSha = baseSha;
  disposition: 'open' | 'closed' | 'merged' = 'open';
  authorized = true;
  async issue() { return this.input; }
  async comments() { return this.messages; }
  async canWrite(actor: string) { return actor === 'maintainer'; }
  async authorizedIntake() { return this.authorized; }
  async baseline() { return { branch: 'main', sha: this.baselineSha }; }
  async load() { return structuredClone(this.stored); }
  async save(record: RecordState) { this.stored = structuredClone(record); }
  async comment(_number: number, key: string, body: string) { this.outputs.set(key, body); }
  async task(_state: Lifecycle, task: Task) { return task.id === 'first' ? 124 : 125; }
  async linkTasks() {}
  async dispatch(job: Job) { this.dispatched.push(structuredClone(job)); }
  async findRun(job: Job) { return this.runs.get(job.id); }
  async cancelRun(runId: number) { this.cancelled.push(runId); }
  async report(run: Run) { return this.reports.get(run.id)!; }
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

async function planned() {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  await controller.tick(123);
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

test('label intake is authorized and duplicate events do not duplicate dispatch', async () => {
  const platform = new FakePlatform();
  const controller = new Controller(platform, policy);
  platform.authorized = false;
  await controller.tick(123);
  assert.equal(platform.stored, undefined);
  platform.authorized = true;
  await controller.tick(123);
  await controller.tick(123);
  assert.equal(platform.dispatched.length, 1);
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
  for (const stage of ['scan', 'security', 'validate', 'review']) {
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

test('issue edits and default branch drift stop execution until replanning', async () => {
  const first = await coding();
  first.platform.input.body = 'Changed scope';
  await first.controller.tick(123);
  assert.equal(first.platform.stored!.state.phase, 'blocked');
  const second = await coding();
  second.platform.baselineSha = 'f'.repeat(40);
  await second.controller.tick(123);
  assert.equal(second.platform.stored!.state.phase, 'blocked');
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
  platform.stored!.state.phase = 'pr_open';
  platform.stored!.state.prNumber = 126;
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
  await controller.tick(123);
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

test('timed-out workers are cancelled and replaced within the infrastructure budget', async () => {
  const platform = new FakePlatform();
  let time = new Date('2026-09-08T12:00:00Z');
  const controller = new Controller(platform, policy, () => time);
  await controller.tick(123);
  const first = platform.stored!.state.job!.id;
  platform.runs.set(first, { id: 20, status: 'in_progress', conclusion: null, url: 'https://github.com/run/20' });
  time = new Date(time.getTime() + policy.jobTimeoutMinutes * 60_000 + 1);
  await controller.tick(123);
  assert.deepEqual(platform.cancelled, [20]);
  assert.notEqual(platform.stored!.state.job!.id, first);
  assert.equal(platform.stored!.state.failures, 1);
});