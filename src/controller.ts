import { approvePlan, makePlan, parseCommand, type Phase } from './domain.ts';
import { reportSchema, type Change, type Policy, type Report } from './contracts.ts';
import { validateChanges } from './changes.ts';
import {
  assertCurrentResult, assertPublishable, createLifecycle, nextTask, recordChange,
  requestRepair, startJob, validateTasks, type Job, type Lifecycle, type Stage, type Task,
} from './lifecycle.ts';

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  open: boolean;
  labeled: boolean;
}
export interface Comment { id: number; body: string; actor: string; human: boolean; createdAt: string }
export interface Run { id: number; status: string; conclusion: string | null; url: string }
export interface RecordState { state: Lifecycle; version?: string }

export interface Platform {
  issue(number: number): Promise<Issue>;
  comments(number: number): Promise<Comment[]>;
  canWrite(actor: string): Promise<boolean>;
  authorizedIntake(number: number): Promise<boolean>;
  baseline(): Promise<{ branch: string; sha: string }>;
  load(number: number): Promise<RecordState | undefined>;
  save(record: RecordState): Promise<void>;
  comment(number: number, key: string, body: string): Promise<void>;
  task(parent: Lifecycle, task: Task): Promise<number>;
  linkTasks(state: Lifecycle): Promise<void>;
  dispatch(job: Job, state: Lifecycle): Promise<void>;
  findRun(job: Job): Promise<Run | undefined>;
  cancelRun(runId: number): Promise<void>;
  report(run: Run, job: Job): Promise<Report>;
  applyChanges(state: Lifecycle, job: Job, changes: Change[]): Promise<string>;
  publish(state: Lifecycle): Promise<number>;
  pullRequest(number: number): Promise<'open' | 'closed' | 'merged'>;
  closeTasks(state: Lifecycle): Promise<void>;
  retireTasks(numbers: number[]): Promise<void>;
}

const stages: Partial<Record<Phase, Stage>> = {
  researching: 'research', decomposing: 'decompose', coding: 'code', scanning: 'scan',
  security: 'security', testing: 'test', validating: 'validate', reviewing: 'review',
};
const terminalPhases: Phase[] = ['cancelled', 'merged'];

export class Controller {
  readonly platform: Platform;
  readonly policy: Policy;
  readonly clock: () => Date;

  constructor(platform: Platform, policy: Policy, clock = () => new Date()) {
    this.platform = platform;
    this.policy = policy;
    this.clock = clock;
  }

  async tick(number: number): Promise<void> {
    const issue = await this.platform.issue(number);
    let record = await this.platform.load(number);
    if (!record) {
      if (!issue.open || !issue.labeled || !await this.platform.authorizedIntake(number)) return;
      const baseline = await this.platform.baseline();
      record = { state: createLifecycle(number, issue.author, this.request(issue), baseline.sha, baseline.branch) };
      await this.platform.save(record);
    }
    const state = record.state;
    if (state.phase === 'merged' || state.phase === 'cancelled' && !state.prNumber) {
      await this.status(state);
      return;
    }
    if (state.prNumber) {
      const disposition = await this.platform.pullRequest(state.prNumber);
      if (disposition === 'merged') {
        state.phase = 'merged';
        await this.platform.closeTasks(state);
        await this.platform.save(record);
        await this.status(state);
        return;
      }
      if (disposition === 'closed' && state.phase !== 'cancelled') {
        state.phase = 'cancelled';
        await this.platform.save(record);
        await this.status(state);
      }
    }
    if (!issue.open || !issue.labeled) {
      if (state.phase !== 'cancelled') await this.interrupt(record, 'cancelled');
      await this.status(state);
      return;
    }
    if (terminalPhases.includes(state.phase) || state.phase === 'pr_open') return;

    const comments = (await this.platform.comments(number)).sort((first, second) => first.id - second.id);
    for (const comment of comments) {
      const key = `comment:${comment.id}`;
      if (!comment.human || state.processedEvents.includes(key)) continue;
      const command = parseCommand(comment.body);
      if (!command) continue;
      const maintainer = await this.platform.canWrite(comment.actor);
      const requester = comment.actor.toLowerCase() === state.requester.toLowerCase();
      state.processedEvents.push(key);
      if (!maintainer && !requester) {
        await this.platform.save(record);
        continue;
      }
      try {
        if (command.kind === 'approve') {
          if (this.request(issue) !== state.request) throw new Error('Issue changed; request a revised plan first');
          state.approval = approvePlan({
            phase: state.phase, plan: state.plan, version: command.version, authorized: true,
            actor: comment.actor, commentId: comment.id, at: comment.createdAt,
          });
          state.phase = 'decomposing';
        } else if (command.kind === 'revise') {
          if (state.prNumber) throw new Error('An open PR must be handled through PR review');
          const baseline = await this.platform.baseline();
          const previousJob = state.job;
          state.retiredTasks.push(...state.tasks.flatMap(task => task.issueNumber ? [task.issueNumber] : []));
          state.job = undefined;
          state.request = this.request(issue);
          state.approval = undefined;
          state.baseSha = baseline.sha;
          state.controlSha = baseline.sha;
          state.headSha = baseline.sha;
          state.baseBranch = baseline.branch;
          state.branch = `agentic/epic-${number}-v${(state.plan?.version ?? 0) + 1}`;
          state.tasks = [];
          state.evidence = [];
          state.feedback = command.feedback.slice(0, 24000);
          state.error = undefined;
          state.phase = 'researching';
          state.resumePhase = undefined;
          await this.platform.save(record);
          if (previousJob) {
            const run = await this.platform.findRun(previousJob);
            if (run && run.status !== 'completed') await this.platform.cancelRun(run.id);
          }
        } else if (command.kind === 'cancel' || command.kind === 'pause') {
          await this.interrupt(record, command.kind === 'pause' ? 'paused' : 'cancelled');
        } else {
          if (!maintainer) throw new Error('Only maintainers can resume or retry execution');
          const expected = command.kind === 'retry' ? 'blocked' : 'paused';
          if (state.phase !== expected || !state.resumePhase) throw new Error(`Lifecycle is not ${expected}`);
          state.phase = state.resumePhase;
          state.job = undefined;
          state.failures = 0;
          state.error = undefined;
        }
      } catch (error) {
        if (error instanceof Error && 'status' in error) throw error;
        await this.platform.comment(number, key, `Command rejected: ${this.message(error)}`);
      }
      await this.platform.save(record);
      if (terminalPhases.includes(state.phase)) break;
    }

    if (state.retiredTasks.length) {
      await this.platform.retireTasks(state.retiredTasks);
      state.retiredTasks = [];
      await this.platform.save(record);
    }

    if (this.request(issue) !== state.request && !['paused', 'blocked', 'cancelled'].includes(state.phase)) {
      await this.interrupt(record, 'blocked');
      state.error = 'Issue text changed. Use /sdlc revise <feedback> to approve the changed scope.';
      await this.platform.save(record);
    }
    await this.status(state);
    if (['awaiting_approval', 'paused', 'blocked', 'cancelled'].includes(state.phase)) return;
    const current = await this.platform.baseline();
    if (current.sha !== state.controlSha || current.branch !== state.baseBranch) {
      await this.interrupt(record, 'blocked');
      state.error = 'The default branch changed. Use /sdlc revise <feedback> to replan against its new revision.';
      await this.platform.save(record);
      await this.status(state);
      return;
    }

    if (state.job) {
      await this.collect(record);
      if (state.job || ['blocked', 'awaiting_approval'].includes(state.phase)) {
        await this.status(state);
        return;
      }
    }
    if (state.tasks.length) {
      for (const task of state.tasks) {
        if (!task.issueNumber) {
          task.issueNumber = await this.platform.task(state, task);
          await this.platform.save(record);
        }
      }
      await this.platform.linkTasks(state);
    }
    if (state.phase === 'publishing') {
      try { assertPublishable(state); }
      catch (error) {
        state.resumePhase = 'coding';
        state.phase = 'blocked';
        state.error = this.message(error);
        await this.platform.save(record);
        await this.status(state);
        return;
      }
      state.prNumber = await this.platform.publish(state);
      state.phase = 'pr_open';
      await this.platform.save(record);
      await this.status(state);
      return;
    }
    const stage = stages[state.phase];
    if (stage) {
      if (state.sequence >= this.policy.maxJobs) {
        state.resumePhase = state.phase;
        state.phase = 'blocked';
        state.error = 'Total job budget exhausted. A maintainer must assess the remaining work.';
        await this.platform.save(record);
      } else {
        startJob(state, stage, this.clock().toISOString());
        await this.platform.save(record);
        await this.send(record);
      }
    }
    await this.status(state);
  }

  private async send(record: RecordState): Promise<void> {
    const job = record.state.job!;
    job.dispatchedAt = this.clock().toISOString();
    await this.platform.save(record);
    await this.platform.dispatch(job, record.state);
  }

  private async collect(record: RecordState): Promise<void> {
    const state = record.state;
    const job = state.job!;
    const run = await this.platform.findRun(job);
    if (!run) {
      const age = this.clock().getTime() - Date.parse(job.dispatchedAt ?? job.createdAt);
      if (!job.dispatchedAt) return this.send(record);
      if (age < this.policy.dispatchGraceMinutes * 60_000) return;
      if (job.attempt >= this.policy.maxJobAttempts) return this.failed(record, 'Worker dispatch did not produce a run');
      job.attempt += 1;
      return this.send(record);
    }
    job.runId = run.id;
    await this.platform.save(record);
    if (run.status !== 'completed') {
      if (this.clock().getTime() - Date.parse(job.createdAt) > this.policy.jobTimeoutMinutes * 60_000) {
        await this.platform.cancelRun(run.id);
        await this.failed(record, `Worker timed out: ${run.url}`);
      }
      return;
    }
    if (run.conclusion !== 'success' &&
      !(run.conclusion === 'failure' && ['scan', 'validate'].includes(job.stage))) {
      return this.failed(record, `Worker ${run.conclusion ?? 'failed'}: ${run.url}`);
    }
    let report: Report;
    try {
      report = reportSchema.parse(await this.platform.report(run, job));
      assertCurrentResult(state, report.jobId, report.inputSha, run.id);
      validateChanges(report.changes, job.stage, this.policy);
      if (job.stage === 'decompose' && report.outcome === 'pass') {
        validateTasks((report.tasks ?? []).map(task => ({ ...task, completed: false })), this.policy.maxTasks);
      }
      if (job.stage === 'research' && report.outcome === 'pass') makePlan(report.plan ?? '', state.plan?.version ?? 0);
    } catch (error) {
      return this.failed(record, `Worker output rejected: ${this.message(error)}`);
    }
    if (report.outcome === 'blocked') {
      state.resumePhase = state.phase;
      state.phase = 'blocked';
      state.error = report.summary;
      state.job = undefined;
      await this.platform.save(record);
      return;
    }
    if (report.outcome === 'changes_requested') {
      if (['research', 'decompose'].includes(job.stage)) return this.failed(record, report.summary);
      requestRepair(state, report.summary, this.policy.maxRepairs);
      await this.platform.save(record);
      return;
    }
    if (report.changes.length) {
      try {
        const sha = await this.platform.applyChanges(state, job, report.changes);
        recordChange(state, sha);
      } catch (error) {
        if (error instanceof Error && 'status' in error) throw error;
        return this.failed(record, `Publisher rejected changes: ${this.message(error)}`);
      }
    }
    state.job = undefined;
    state.failures = 0;
    state.error = undefined;
    if (job.stage === 'research') {
      state.plan = makePlan(report.plan!, state.plan?.version ?? 0);
      state.phase = 'awaiting_approval';
      state.feedback = '';
    } else if (job.stage === 'decompose') {
      state.tasks = report.tasks!.map(task => ({ ...task, completed: false }));
      state.phase = 'coding';
    } else if (job.stage === 'code') {
      const task = state.tasks.find(task => task.id === job.taskId);
      if (task) task.completed = true;
      state.feedback = '';
      state.phase = nextTask(state) ? 'coding' : 'scanning';
    } else {
      state.evidence = state.evidence.filter(item => item.stage !== job.stage);
      state.evidence.push({ stage: job.stage, sha: state.headSha, jobId: job.id, runId: run.id, summary: report.summary });
      if (job.stage === 'scan') state.phase = 'security';
      if (job.stage === 'security') state.phase = state.evidence.some(item => item.stage === 'test' && item.sha === state.headSha)
        ? 'validating' : 'testing';
      if (job.stage === 'test') state.phase = report.changes.length ? 'scanning' : 'validating';
      if (job.stage === 'validate') state.phase = 'reviewing';
      if (job.stage === 'review') state.phase = 'publishing';
    }
    await this.platform.save(record);
    await this.platform.comment(state.issueNumber, `job:${job.id}`, `### ${job.stage}\n\n${report.summary}\n\n[Workflow evidence](${run.url})`);
  }

  private async failed(record: RecordState, message: string): Promise<void> {
    const state = record.state;
    state.failures += 1;
    state.job = undefined;
    state.error = message;
    if (state.failures >= this.policy.maxJobAttempts) {
      state.resumePhase = state.phase;
      state.phase = 'blocked';
    }
    await this.platform.save(record);
  }

  private async interrupt(record: RecordState, phase: 'paused' | 'cancelled' | 'blocked'): Promise<void> {
    const state = record.state;
    const job = state.job;
    if (!['paused', 'blocked', 'cancelled', 'merged'].includes(state.phase)) state.resumePhase = state.phase;
    state.phase = phase;
    state.job = undefined;
    await this.platform.save(record);
    if (job) {
      const run = await this.platform.findRun(job);
      if (run && run.status !== 'completed') await this.platform.cancelRun(run.id);
    }
  }

  private async status(state: Lifecycle): Promise<void> {
    if (state.phase === 'awaiting_approval' && state.plan) {
      await this.platform.comment(state.issueNumber, `plan:${state.plan.hash}`,
        `## Proposed plan v${state.plan.version}\n\n${state.plan.body}\n\nPlan hash: \`${state.plan.hash}\`\n\n` +
        `@${state.requester}: approve with \`/sdlc approve v${state.plan.version}\` or request changes with \`/sdlc revise <feedback>\`.`);
    }
    await this.platform.comment(state.issueNumber, 'status',
      `## Agentic SDLC\n\nState: **${state.phase}**\n\n` +
      `Tasks: ${state.tasks.filter(task => task.completed).length}/${state.tasks.length}. ` +
      `Jobs: ${state.sequence}/${this.policy.maxJobs}. Repairs: ${state.repairs}/${this.policy.maxRepairs}.\n\n` +
      (state.job ? `Active job: \`${state.job.id}\` (${state.job.stage}).\n\n` : '') +
      (state.error ? `${state.error}\n\n` : '') +
      (state.prNumber ? `Feature PR: #${state.prNumber}\n\n` : '') +
      'Controls: `/sdlc pause`, `/sdlc resume`, `/sdlc cancel`, `/sdlc retry`.');
  }

  private request(issue: Issue): string { return `${issue.title}\n\n${issue.body}`.slice(0, 60000); }
  private message(error: unknown): string { return (error instanceof Error ? error.message : 'Unexpected controller failure').slice(0, 12000); }
}