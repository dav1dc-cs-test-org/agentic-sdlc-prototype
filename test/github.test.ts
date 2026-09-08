import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Octokit } from '@octokit/rest';
import { strToU8, zipSync } from 'fflate';
import { GitHub, decodeReportArchive } from '../src/github.ts';
import { policySchema } from '../src/contracts.ts';
import { createLifecycle, startJob } from '../src/lifecycle.ts';
import { approvePlan, digest, makePlan } from '../src/domain.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const baseSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);

function api(handler: (method: string, path: string, body: Record<string, unknown>) => unknown) {
  return new Octokit({ request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const result = handler(init?.method ?? 'GET', decodeURIComponent(url.pathname), init?.body ? JSON.parse(String(init.body)) : {});
    const response = result instanceof Response ? result :
      new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } } });
}

function active() {
  const state = createLifecycle(123, 'requester', 'Feature', baseSha);
  state.plan = makePlan('Approved plan', 0);
  state.approval = approvePlan({ phase: 'awaiting_approval', plan: state.plan, version: 1,
    authorized: true, actor: 'requester', commentId: 1, at: '2026-09-08T12:00:00Z' });
  state.phase = 'coding';
  state.feedback = 'Implement the accepted repair';
  const job = startJob(state, 'code', '2026-09-08T12:00:00Z');
  return { state, job };
}

test('artifact decoding accepts only the bounded result file and a strict schema', () => {
  const report = { jobId: '123-1', inputSha: baseSha, outcome: 'pass', summary: 'Done', changes: [] };
  assert.deepEqual(decodeReportArchive(zipSync({ 'result.json': strToU8(JSON.stringify(report)) })), report);
  assert.throws(() => decodeReportArchive(zipSync({ '../result.json': strToU8('{}') })), /Missing/);
  assert.throws(() => decodeReportArchive(new Uint8Array(2_000_001)), /size/);
  assert.throws(() => decodeReportArchive(zipSync({ 'result.json': strToU8('{"outcome":"pass"}') })));
});

test('state writes carry the prior content SHA for compare-and-swap', async () => {
  const { state } = active();
  let written: Record<string, unknown> | undefined;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
    assert.equal(method, 'PUT');
    written = body;
    return { content: { sha: newSha } };
  }));
  const record = { state, version: baseSha };
  await github.save(record);
  assert.equal(written?.sha, baseSha);
  assert.equal(written?.branch, 'sdlc-state');
  assert.equal(record.version, newSha);
});

test('worker discovery rejects runs from other actors, commits, or reruns', async () => {
  const { job } = active();
  const valid = { id: 3, display_title: `SDLC ${job.id}`, head_sha: baseSha, actor: { login: 'sdlc[bot]' },
    run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/3' };
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ total_count: 4, workflow_runs: [
    { ...valid, id: 1, actor: { login: 'stranger' } },
    { ...valid, id: 2, head_sha: newSha }, valid, { ...valid, id: 4, run_attempt: 2 },
  ] })));
  assert.equal((await github.findRun(job))?.id, 3);
});

test('failed check workflows need a successful trusted result job before their artifacts are accepted', async () => {
  const { job } = active();
  job.stage = 'scan';
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({ total_count: 1,
    jobs: [{ name: 'SDLC Check Result', conclusion: 'failure' }],
  })));
  await assert.rejects(github.report({ id: 1, status: 'completed', conclusion: 'failure', url: 'https://github.com/run/1' }, job), /trusted check-result/);
});

test('a commit already published before a crash is recovered without writing again', async () => {
  const { state, job } = active();
  const changes = [{ path: 'feature.txt', content: 'Feature' }];
  const blob = createHash('sha1').update('blob 7\0Feature').digest('hex');
  let contentSha = blob;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path) => {
    assert.equal(method, 'GET');
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path.includes('/git/commits/')) return {
      message: `SDLC ${job.id} ${digest(changes)}`, parents: [{ sha: baseSha }],
      tree: { sha: path.endsWith(newSha) ? 'd'.repeat(40) : 'c'.repeat(40) },
    };
    return { truncated: false, tree: path.endsWith('d'.repeat(40)) ? [
      { path: 'feature.txt', mode: '100644', type: 'blob', sha: contentSha },
    ] : [] };
  }));
  assert.equal(await github.applyChanges(state, job, changes), newSha);
  contentSha = 'e'.repeat(40);
  await assert.rejects(github.applyChanges(state, job, changes), /Published tree/);
});

test('publisher preserves baseline tests and refuses symlink ancestors', async () => {
  const { state, job } = active();
  for (const path of ['test/domain.test.ts', 'linked/file.ts']) {
    const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, route) => {
      assert.equal(method, 'GET');
      if (route.includes('/git/ref/')) return { object: { sha: baseSha } };
      if (route.includes('/git/commits/')) return { tree: { sha: 'c'.repeat(40) } };
      return { truncated: false, tree: [
        { path: 'test/domain.test.ts', type: 'blob', mode: '100644', sha: baseSha },
        { path: 'linked', type: 'blob', mode: '120000', sha: baseSha },
      ] };
    }));
    await assert.rejects(github.applyChanges(state, job, [{ path, content: 'Changed' }]), /immutable|ancestor/);
  }
});

test('publisher applies a validated tree to only the working branch without force', async () => {
  const { state, job } = active();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (method !== 'GET') writes.push({ path, body });
    if (path.includes('/git/ref/')) return { object: { sha: baseSha } };
    if (path.includes('/git/commits/') && method === 'GET') return { tree: { sha: 'c'.repeat(40) } };
    if (method === 'GET') return { truncated: false, tree: [] };
    return { sha: newSha };
  }));
  assert.equal(await github.applyChanges(state, job, [{ path: 'feature.txt', content: 'Feature' }]), newSha);
  const update = writes.at(-1)!;
  assert.match(update.path, /refs\/heads\/agentic\/epic-123-v1$/);
  assert.equal(update.body.force, false);
  assert.equal(writes[0]!.body.base_tree, 'c'.repeat(40));
});

test('final PR, advisory review, and commit check are idempotent and reference the reviewed SHA', async () => {
  const { state } = active();
  state.phase = 'publishing';
  state.job = undefined;
  state.headSha = newSha;
  state.tasks = [{ id: 'feature', title: 'Feature', description: 'Feature', acceptance: ['Works'], dependsOn: [], completed: true }];
  state.evidence = ['scan', 'security', 'test', 'validate', 'review'].map(stage => ({
    stage: stage as 'scan' | 'security' | 'test' | 'validate' | 'review', sha: newSha,
    jobId: `123-${stage}`, runId: 1, summary: 'Verified',
  }));
  const pulls: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const checks: Record<string, unknown>[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (path.includes('/git/ref/')) return { object: { sha: newSha } };
    if (path.endsWith('/issues/123')) return { title: 'Feature', body: 'Request', user: { login: 'requester' }, state: 'open', labels: [] };
    if (path.endsWith('/pulls')) {
      if (method === 'GET') return pulls;
      pulls.push({ ...body, number: 126, user: { login: 'sdlc[bot]' } });
      return { number: 126 };
    }
    if (path.endsWith('/reviews')) {
      if (method === 'GET') return reviews;
      reviews.push({ ...body, user: { login: 'sdlc[bot]' } });
      return { id: 1 };
    }
    if (path.endsWith('/check-runs')) {
      if (method === 'GET') return { total_count: checks.length, check_runs: checks };
      checks.push({ ...body, app: { slug: 'sdlc' } });
      return { id: 1 };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
  assert.equal(await github.publish(state), 126);
  assert.equal(await github.publish(state), 126);
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0]!.head, state.branch);
  assert.equal(pulls[0]!.base, 'main');
  assert.equal(pulls[0]!.draft, false);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.event, 'COMMENT');
  assert.equal(reviews[0]!.commit_id, newSha);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.head_sha, newSha);
});

test('state reads validate identity and reject corrupt or oversized data', async () => {
  const { state } = active();
  let stored = state;
  let size = 100;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api(() => ({
    type: 'file', sha: newSha, size, content: Buffer.from(JSON.stringify(stored)).toString('base64'),
  })));
  assert.equal((await github.load(123))!.version, newSha);
  stored = { ...state, issueNumber: 124 };
  await assert.rejects(github.load(123), /identity/);
  stored = state; size = 1_000_001;
  await assert.rejects(github.load(123), /Invalid state/);
});

test('intake authorization checks the latest labeler and live repository permission', async () => {
  let actor = { login: 'maintainer', type: 'User' };
  let permission = 'write';
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((_method, path) => {
    if (path.endsWith('/events')) return [{ event: 'labeled', label: { name: 'agentic-SDLC' }, actor }];
    return { permission };
  }));
  assert.equal(await github.authorizedIntake(123), true);
  permission = 'read';
  assert.equal(await github.authorizedIntake(123), false);
  actor = { login: 'sdlc[bot]', type: 'Bot' };
  assert.equal(await github.authorizedIntake(123), false);
});

test('only controller-owned comments are updated and edited commands are ignored', async () => {
  const comments: Record<string, unknown>[] = [{ id: 1, body: '<!-- sdlc:status -->\nForged', user: { login: 'stranger', type: 'User' },
    created_at: '2026-09-08T12:00:00Z', updated_at: '2026-09-08T13:00:00Z' }];
  let updates = 0;
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, _path, body) => {
    if (method === 'GET') return comments;
    if (method === 'POST') comments.push({ id: 2, body: body.body, user: { login: 'sdlc[bot]', type: 'Bot' } });
    if (method === 'PATCH') { updates += 1; comments[1]!.body = body.body; }
    return {};
  }));
  await github.comment(123, 'status', 'Running');
  await github.comment(123, 'status', 'Running');
  await github.comment(123, 'status', 'Done');
  assert.equal(comments.length, 2);
  assert.equal(updates, 1);
  assert.equal((await github.comments(123))[0]!.human, false);
});

test('state storage bootstraps an isolated branch and preserves compare-and-swap on creation', async () => {
  const { state } = active();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const github = new GitHub('owner/repo', policy, 'sdlc[bot]', api((method, path, body) => {
    if (method === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
    writes.push({ path, body });
    if (method === 'PUT') return { content: { sha: newSha } };
    return { sha: baseSha };
  }));
  assert.equal(await github.load(123), undefined);
  await github.save({ state });
  assert.deepEqual(writes.find(write => write.path.endsWith('/commits'))!.body.parents, []);
  assert.equal(writes.find(write => write.path.endsWith('/refs'))!.body.ref, 'refs/heads/sdlc-state');
});