import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Controller, RetryablePlatformError, type Comment, type Platform, type RecordState, type Run } from '../src/controller.ts';
import { lifecycleSchema, policySchema, type Change, type Intake, type Report } from '../src/contracts.ts';
import type { Job, Lifecycle, Task } from '../src/lifecycle.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);

class FakePlatform implements Platform {
  raw?: string;
  version?: string;
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
    return this.raw === undefined ? undefined :
      { state: lifecycleSchema.parse(JSON.parse(this.raw)), version: this.version };
  }
  async save(record: RecordState) {
    lifecycleSchema.parse(record.state);
    this.raw = JSON.stringify(record.state);
    this.version = `${Number(this.version ?? 0) + 1}`;
    record.version = this.version;
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