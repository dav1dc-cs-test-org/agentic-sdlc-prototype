import { z } from 'zod';
import type { Lifecycle } from './lifecycle.ts';

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const numberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1);
export const stageSchema = z.enum(['research', 'decompose', 'code', 'scan', 'security', 'test', 'validate', 'review']);
export const phaseSchema = z.enum([
  'researching', 'awaiting_approval', 'decomposing', 'coding', 'scanning', 'security',
  'testing', 'validating', 'reviewing', 'publishing', 'pr_open', 'merged', 'blocked', 'paused', 'cancelled',
]);

export const taskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text.max(160), description: text.max(6000),
  acceptance: z.array(text.max(1000)).min(1).max(12),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(12),
}).strict();

export const changeSchema = z.object({
  path: text.max(240), content: z.string().max(512_000).nullable(),
}).strict();
export type Change = z.infer<typeof changeSchema>;

export const reportSchema = z.object({
  jobId: z.string().regex(/^\d+-\d+$/),
  inputSha: shaSchema,
  outcome: z.enum(['pass', 'changes_requested', 'blocked']),
  summary: text.max(12000),
  plan: text.max(24000).optional(),
  tasks: z.array(taskSchema).max(12).optional(),
  changes: z.array(changeSchema).max(60).default([]),
}).strict();
export type Report = z.infer<typeof reportSchema>;

export const policySchema = z.object({
  label: z.literal('agentic-SDLC'),
  stateBranch: z.literal('sdlc-state'),
  maxTasks: numberSchema.max(12), maxRepairs: z.number().int().min(0).max(5),
  maxJobAttempts: numberSchema.max(3), maxJobs: numberSchema.max(100),
  jobTimeoutMinutes: numberSchema.max(180), dispatchGraceMinutes: numberSchema.max(30),
  maxFiles: numberSchema.max(60), maxChangeBytes: numberSchema.max(1_000_000),
  protectedPaths: z.array(text).min(1), testPaths: z.array(text).min(1),
  sourcePaths: z.array(text).min(1),
  coverage: z.object({
    lines: z.number().min(1).max(100), branches: z.number().min(1).max(100),
    maxDrop: z.number().min(0).max(5),
  }).strict(),
}).strict();
export type Policy = z.infer<typeof policySchema>;

const jobSchema = z.object({
  id: z.string().regex(/^\d+-\d+$/), stage: stageSchema,
  inputSha: shaSchema, controlSha: shaSchema, planHash: hashSchema.nullable(),
  taskId: z.string().nullable(), feedback: z.string().max(24000),
  attempt: numberSchema.max(3), createdAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().optional(), runId: numberSchema.optional(),
}).strict();

export const lifecycleSchema = z.object({
  schemaVersion: z.literal(1), issueNumber: numberSchema,
  requester: text.max(100), request: text.max(60000), phase: phaseSchema,
  baseSha: shaSchema, headSha: shaSchema, controlSha: shaSchema,
  baseBranch: text.max(200), branch: z.string().regex(/^agentic\/epic-\d+-v\d+$/),
  plan: z.object({ version: numberSchema, body: text.max(24000), hash: hashSchema }).strict().optional(),
  approval: z.object({
    actor: text.max(100), commentId: numberSchema, planHash: hashSchema, at: z.iso.datetime(),
  }).strict().optional(),
  tasks: z.array(taskSchema.extend({ issueNumber: numberSchema.optional(), completed: z.boolean() })).max(12),
  retiredTasks: z.array(numberSchema).max(120),
  job: jobSchema.optional(),
  evidence: z.array(z.object({
    stage: stageSchema, sha: shaSchema, jobId: text, runId: numberSchema, summary: text.max(12000),
  }).strict()).max(100),
  processedEvents: z.array(z.string()).max(10000),
  sequence: z.number().int().min(0), repairs: z.number().int().min(0), failures: z.number().int().min(0),
  feedback: z.string().max(24000), resumePhase: phaseSchema.optional(), error: z.string().max(12000).optional(),
  prNumber: numberSchema.optional(),
}).strict() satisfies z.ZodType<Lifecycle>;