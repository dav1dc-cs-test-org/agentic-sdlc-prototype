import assert from 'node:assert/strict';
import test from 'node:test';
import { approvePlan, makePlan } from '../src/domain.ts';
import {
  assertCurrentResult, assertPublishable, createLifecycle, nextTask, recordChange,
  requestRepair, startJob, validateTasks, type Task,
} from '../src/lifecycle.ts';

const at = '2026-09-08T12:00:00Z';
const baseSha = 'a'.repeat(40);
const finalSha = 'b'.repeat(40);
const tasks: Task[] = [
  { id: 'api', title: 'API', description: 'Implement API', acceptance: ['Works'], dependsOn: ['model'], completed: false },
  { id: 'model', title: 'Model', description: 'Implement model', acceptance: ['Works'], dependsOn: [], completed: false },
];

function approvedState() {
  const state = createLifecycle(123, 'requester', 'Add a feature', baseSha);
  state.plan = makePlan('An agreed implementation plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at });
  state.tasks = structuredClone(tasks);
  return state;
}

test('task ordering follows dependencies rather than list order', () => {
  const state = approvedState();
  validateTasks(state.tasks, 5);
  assert.equal(nextTask(state)?.id, 'model');
  state.tasks[1]!.completed = true;
  assert.equal(nextTask(state)?.id, 'api');
});

test('task graphs reject cycles, duplicates, missing dependencies, and excess tasks', () => {
  assert.throws(() => validateTasks([tasks[0]!], 5), /Unknown/);
  assert.throws(() => validateTasks([tasks[1]!, tasks[1]!], 5), /Duplicate/);
  assert.throws(() => validateTasks(tasks, 1), /count/);
  assert.throws(() => validateTasks([tasks[0]!, { ...tasks[1]!, dependsOn: ['api'] }], 5), /Cyclic/);
});

test('coding cannot start without approval or in the wrong phase', () => {
  const state = approvedState();
  assert.throws(() => startJob(state, 'code', at), /phase/);
  state.phase = 'coding';
  state.approval = undefined;
  assert.throws(() => startJob(state, 'code', at), /approved plan/);
});

test('worker results must match the exact job, run, plan, and input commit', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  assert.equal(assertCurrentResult(state, job.id, baseSha, 10), job);
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 11), /Stale/);
  recordChange(state, finalSha);
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 10), /Stale/);
});

test('paused lifecycles reject in-flight output', () => {
  const state = approvedState();
  state.phase = 'coding';
  const job = startJob(state, 'code', at);
  job.runId = 10;
  state.phase = 'paused';
  assert.throws(() => assertCurrentResult(state, job.id, baseSha, 10), /not running/);
});

test('new code invalidates all prior gate evidence', () => {
  const state = approvedState();
  state.evidence = [{ stage: 'security', sha: baseSha, jobId: '123-1', runId: 1, summary: 'Pass' }];
  recordChange(state, finalSha);
  assert.deepEqual(state.evidence, []);
});

test('repair attempts stop at the configured budget', () => {
  const state = approvedState();
  requestRepair(state, 'Fix the regression', 1);
  assert.equal(state.phase, 'coding');
  requestRepair(state, 'Still failing', 1);
  assert.equal(state.phase, 'blocked');
});

test('publication requires every task and all gate evidence on the final commit', () => {
  const state = approvedState();
  state.phase = 'publishing';
  state.headSha = finalSha;
  state.tasks.forEach(task => { task.completed = true; });
  assert.throws(() => assertPublishable(state), /scan/);
  state.evidence = ['scan', 'security', 'test', 'validate', 'document', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'document' | 'review', sha: finalSha,
    jobId: `123-${stage}`, runId: 1, summary: 'Pass',
  }));
  assert.doesNotThrow(() => assertPublishable(state));
  state.evidence[0]!.sha = 'old';
  assert.throws(() => assertPublishable(state), /scan/);
});