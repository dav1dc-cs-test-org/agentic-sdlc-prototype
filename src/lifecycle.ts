import { digest, type Approval, type Phase, type Plan } from './domain.ts';

export type Stage = 'research' | 'decompose' | 'code' | 'scan' | 'security' | 'test' | 'validate' | 'review';

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  issueNumber?: number;
  completed: boolean;
}

export interface Job {
  id: string;
  stage: Stage;
  inputSha: string;
  controlSha: string;
  planHash: string | null;
  taskId: string | null;
  feedback: string;
  attempt: number;
  createdAt: string;
  dispatchedAt?: string;
  runId?: number;
}

export interface Evidence {
  stage: Stage;
  sha: string;
  jobId: string;
  runId: number;
  summary: string;
}

export interface Lifecycle {
  schemaVersion: 1;
  issueNumber: number;
  requester: string;
  request: string;
  phase: Phase;
  baseSha: string;
  baseBranch: string;
  controlSha: string;
  headSha: string;
  branch: string;
  plan?: Plan;
  approval?: Approval;
  tasks: Task[];
  tasksLinked?: boolean;
  retiredTasks: number[];
  job?: Job;
  evidence: Evidence[];
  processedEvents: string[];
  sequence: number;
  repairs: number;
  failures: number;
  feedback: string;
  resumePhase?: Phase;
  error?: string;
  prNumber?: number;
}

export function createLifecycle(issueNumber: number, requester: string, request: string, baseSha: string, baseBranch = 'main'): Lifecycle {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error('Lifecycle requires an issue number and immutable commit SHA');
  }
  return {
    schemaVersion: 1, issueNumber, requester, request, phase: 'researching',
    baseSha, headSha: baseSha, baseBranch, controlSha: baseSha, branch: `agentic/epic-${issueNumber}-v1`,
    tasks: [], retiredTasks: [], evidence: [], processedEvents: [], sequence: 0, repairs: 0, failures: 0, feedback: '',
  };
}

export function validateTasks(tasks: Task[], maximum: number): void {
  if (!tasks.length || tasks.length > maximum) throw new Error('Task count exceeds policy');
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Duplicate task IDs');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Cyclic task dependencies');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('Unknown task dependency');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
}

export function nextTask(state: Lifecycle): Task | undefined {
  return state.tasks.find(task => !task.completed && task.dependsOn.every(id =>
    state.tasks.some(dependency => dependency.id === id && dependency.completed)));
}

export function assertApproved(state: Lifecycle): void {
  if (!state.plan || !state.approval || state.plan.hash !== state.approval.planHash ||
      state.plan.hash !== digest({ version: state.plan.version, body: state.plan.body })) {
    throw new Error('An intact approved plan is required');
  }
}

export function startJob(state: Lifecycle, stage: Stage, at: string): Job {
  if (state.job) throw new Error('A job is already active');
  const phases: Record<Stage, Phase> = {
    research: 'researching', decompose: 'decomposing', code: 'coding',
    scan: 'scanning', security: 'security', test: 'testing', validate: 'validating', review: 'reviewing',
  };
  if (state.phase !== phases[stage]) throw new Error('Stage does not match lifecycle phase');
  if (stage !== 'research') assertApproved(state);
  const task = stage === 'code' ? nextTask(state) : undefined;
  if (stage === 'code' && !task && !state.feedback) throw new Error('No dependency-ready task');
  state.sequence += 1;
  state.job = {
    id: `${state.issueNumber}-${state.sequence}`, stage, inputSha: state.headSha, controlSha: state.controlSha,
    planHash: state.plan?.hash ?? null, taskId: task?.id ?? null,
    feedback: state.feedback, attempt: 1, createdAt: at,
  };
  return state.job;
}

export function assertCurrentResult(state: Lifecycle, jobId: string, sha: string, runId: number): Job {
  const job = state.job;
  if (!job || job.id !== jobId || job.inputSha !== sha || job.runId !== runId ||
      state.headSha !== sha || job.controlSha !== state.controlSha || job.planHash !== (state.plan?.hash ?? null)) {
    throw new Error('Stale or unrecognized worker result');
  }
  if (['paused', 'cancelled', 'blocked'].includes(state.phase)) throw new Error('Lifecycle is not running');
  if (job.stage !== 'research') assertApproved(state);
  return job;
}

export function recordChange(state: Lifecycle, sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Changes require an immutable commit SHA');
  if (sha !== state.headSha) {
    state.headSha = sha;
    state.evidence = [];
  }
}

export function requestRepair(state: Lifecycle, feedback: string, maximum: number): void {
  state.job = undefined;
  state.evidence = [];
  state.feedback = feedback;
  state.repairs += 1;
  if (state.repairs > maximum) {
    state.phase = 'blocked';
    state.resumePhase = 'coding';
    state.error = 'Repair budget exhausted; maintainer intervention required';
  } else {
    state.phase = 'coding';
  }
}

export function assertPublishable(state: Lifecycle): void {
  assertApproved(state);
  if (state.phase !== 'publishing' || state.job || !state.tasks.length ||
      state.tasks.some(task => !task.completed) || state.headSha === state.baseSha) {
    throw new Error('Lifecycle is not ready for publication');
  }
  for (const stage of ['scan', 'security', 'test', 'validate', 'review'] as const) {
    if (!state.evidence.some(item => item.stage === stage && item.sha === state.headSha)) {
      throw new Error(`Missing current ${stage} evidence`);
    }
  }
}