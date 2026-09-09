import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateChanges } from './changes.ts';
import { policySchema, reportSchema, shaSchema, type Change, type Policy } from './contracts.ts';
import { GitHub } from './github.ts';
import { assertApproved, type Lifecycle, type Stage } from './lifecycle.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function prepareContext(state: Lifecycle, input: {
  issue: number; job: string; sourceSha: string; controlSha: string; stage: string;
}): void {
  const job = state.job;
  if (!job || state.issueNumber !== input.issue || job.id !== input.job ||
      job.inputSha !== input.sourceSha || state.headSha !== input.sourceSha ||
      job.controlSha !== input.controlSha || state.controlSha !== input.controlSha || job.stage !== input.stage ||
      ['paused', 'cancelled', 'blocked', 'merged', 'pr_open'].includes(state.phase)) {
    throw new Error('Dispatch does not match a runnable registered job');
  }
  if (job.stage !== 'research') assertApproved(state);
}

export function collectChanges(source: string, sha: string, stage: Stage, policy: Policy): Change[] {
  shaSchema.parse(sha);
  const directory = realpathSync(source);
  const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', maxBuffer: 2_000_000, timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false' },
  }).split('\0').filter(Boolean);
  const paths = new Set([
    ...git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', sha, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const changes: Change[] = [];
  for (const path of paths) {
    validateChanges([{ path, content: '' }], stage, policy);
    const absolute = resolve(directory, path);
    if (!absolute.startsWith(directory + sep)) throw new Error('File escapes the source checkout');
    try {
      const info = lstatSync(absolute);
      if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > policy.maxChangeBytes) {
        throw new Error('Only bounded regular text files can be collected');
      }
      changes.push({ path, content: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolute)) });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') changes.push({ path, content: null });
      else throw error;
    }
  }
  validateChanges(changes, stage, policy);
  return changes.sort((first, second) => first.path.localeCompare(second.path));
}

async function prepare(): Promise<void> {
  const policy = policySchema.parse(JSON.parse(readFileSync(join(root, '.github/sdlc/policy.json'), 'utf8')));
  const input = {
    issue: z.coerce.number().int().positive().parse(process.env.SDLC_ISSUE), job: process.env.SDLC_JOB ?? '',
    sourceSha: shaSchema.parse(process.env.SDLC_SOURCE_SHA), controlSha: shaSchema.parse(process.env.SDLC_CONTROL_SHA),
    stage: process.env.SDLC_STAGE ?? '',
  };
  if (process.env.GITHUB_SHA !== input.controlSha || process.env.GITHUB_ACTOR !== process.env.SDLC_BOT_LOGIN) {
    throw new Error('Worker must run the trusted workflow revision under the controller App identity');
  }
  const github = new GitHub(process.env.GITHUB_REPOSITORY ?? '', policy, process.env.SDLC_BOT_LOGIN ?? '',
    new Octokit({ auth: process.env.GH_TOKEN }));
  const record = await github.load(input.issue);
  if (!record) throw new Error('No registered lifecycle');
  prepareContext(record.state, input);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base_sha=${shaSchema.parse(record.state.baseSha)}\n`);
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  writeFileSync(join(workspace, '.sdlc-context.json'), JSON.stringify({ state: record.state, policy }, null, 2));
  mkdirSync(join(workspace, '.sdlc-output'), { recursive: true });
}

function collect(): void {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const context = JSON.parse(readFileSync(join(workspace, '.sdlc-context.json'), 'utf8')) as { state: Lifecycle; policy: Policy };
  const job = context.state.job!;
  const raw = reportSchema.omit({ jobId: true, inputSha: true, changes: true })
    .parse(JSON.parse(readFileSync(join(workspace, '.sdlc-output/report.json'), 'utf8')));
  const changes = collectChanges(join(workspace, 'source'), job.inputSha, job.stage, context.policy);
  const report = reportSchema.parse({ ...raw, jobId: job.id, inputSha: job.inputSha, changes });
  writeFileSync(join(workspace, '.sdlc-output/result.json'), JSON.stringify(report));
}

function checks(): void {
  const jobId = process.env.SDLC_JOB;
  const inputSha = process.env.SDLC_SOURCE_SHA;
  const stage = process.env.SDLC_STAGE;
  if (!['scan', 'validate'].includes(stage ?? '')) throw new Error('Unexpected check stage');
  const results = JSON.parse(process.env.SDLC_CHECK_RESULTS ?? '{}') as Record<string, { result?: string }>;
  const required = stage === 'scan' ? ['prepare', 'codeql', 'security'] : ['prepare', 'tests'];
  const failed = required.filter(name => results[name]?.result !== 'success');
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const report = reportSchema.parse({ jobId, inputSha,
    outcome: failed.length ? 'changes_requested' : 'pass',
    summary: failed.length ? `Required checks failed or did not run: ${failed.join(', ')}. Inspect ${url}.` :
      stage === 'scan' ? 'CodeQL, dependency audit, and secret scanning passed.' :
        'Baseline and candidate test suites passed; candidate coverage meets the fixed thresholds and non-regression requirement.',
    changes: [],
  });
  mkdirSync('.sdlc-output', { recursive: true });
  writeFileSync('.sdlc-output/result.json', JSON.stringify(report));
}

if (import.meta.main) {
  const operation = process.argv[2];
  if (operation === 'prepare') await prepare();
  else if (operation === 'collect') collect();
  else if (operation === 'checks') checks();
  else throw new Error('Expected prepare, collect, or checks');
}