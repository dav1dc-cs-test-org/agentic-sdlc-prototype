import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const read = (name: string) => parse(readFileSync(`.github/workflows/${name}`, 'utf8'));

test('controller listens for intake, new commands, completion, and recovery events', () => {
  const workflow = read('sdlc-controller.yml');
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.ok(workflow.on.issues.types.includes('labeled'));
  assert.ok(workflow.on.schedule.length);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.reconcile.environment, 'sdlc-controller');
  assert.match(workflow.jobs.reconcile.if, /SDLC_ENABLED/);
  assert.match(workflow.jobs.reconcile.if, /default_branch/);
});

test('controller fails loudly when the worker actor gate cannot match the App', () => {
  const steps = read('sdlc-controller.yml').jobs.reconcile.steps as { run?: string; env?: Record<string, string> }[];
  const guard = steps.find(step => step.env?.expected === '${{ vars.SDLC_APP_SLUG }}');
  assert.ok(guard, 'the controller must compare SDLC_APP_SLUG against the minted App slug');
  assert.equal(guard.env?.actual, '${{ steps.app.outputs.app-slug }}');
  assert.match(guard.run ?? '', /exit 1/);
  assert.ok(steps.indexOf(guard) < steps.findIndex(step => step.run?.includes('src/main.ts')));
});

test('generated agents have no publishing credentials or direct write permissions', () => {
  const source = readFileSync('.github/workflows/sdlc-agent.md', 'utf8');
  const frontmatter = parse(source.split('---')[1]!);
  assert.equal(frontmatter.permissions.contents, 'read');
  assert.equal(frontmatter.permissions.issues, 'read');
  assert.equal(frontmatter.permissions['pull-requests'], 'read');
  assert.equal(frontmatter.checkout[0].ref, '${{ github.sha }}');
  assert.ok(frontmatter['max-ai-credits'] <= 200);
  assert.equal(frontmatter['safe-outputs']['report-failure-as-issue'], false);
  assert.equal(frontmatter['safe-outputs']['report-failed-jobs'], false);
  assert.equal(frontmatter['safe-outputs']['missing-tool'], false);
  assert.equal(frontmatter['safe-outputs']['missing-data'], false);
  assert.equal(frontmatter['safe-outputs']['report-incomplete']['create-issue'], false);
  assert.equal(source.includes('SDLC_APP_PRIVATE_KEY'), false);
  assert.equal(source.includes('create-github-app-token'), false);
  assert.equal(source.includes('create-pull-request:'), false);
  const compiled = read('sdlc-agent.lock.yml');
  assert.equal(compiled.jobs.agent.permissions.contents, 'read');
  const mutationScopes = ['contents', 'issues', 'pull-requests', 'checks', 'deployments', 'packages', 'security-events'];
  for (const job of Object.values(compiled.jobs) as { permissions?: Record<string, string> }[]) {
    for (const scope of mutationScopes) assert.notEqual(job.permissions?.[scope], 'write');
  }
  const serialized = JSON.stringify(compiled);
  assert.equal(serialized.includes('"GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE":"true"'), false);
  assert.equal(serialized.includes('"GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE":"false"'), true);
});

test('checks cannot pass by silently skipping a required stage', () => {
  const workflow = read('sdlc-checks.yml');
  assert.deepEqual(workflow.jobs.result.needs, ['prepare', 'codeql', 'security', 'tests']);
  assert.match(workflow.jobs.result.if, /always\(\)/);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.tests.permissions, undefined);
  assert.equal(JSON.stringify(workflow.jobs.tests).includes('secrets.'), false);
  assert.equal(workflow.jobs.codeql.steps.find((step: { uses?: string }) => step.uses?.includes('/init@')).with['build-mode'], 'none');
});

test('manual workflows pin actions to immutable commits and never persist git credentials', () => {
  for (const name of ['ci.yml', 'sdlc-controller.yml', 'sdlc-checks.yml']) {
    for (const job of Object.values(read(name).jobs) as { steps: { uses?: string; with?: Record<string, unknown> }[] }[]) {
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false);
      }
    }
  }
});

test('cost accounting stays bound to the compiler and policy it measures', () => {
  const compiled = readFileSync('.github/workflows/sdlc-agent.lock.yml', 'utf8');
  const policy = JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8'));
  // A renamed gh-aw step would silently report every run as never pre-empted.
  assert.ok(compiled.includes('id: parse-mcp-gateway'), 'the gh-aw gateway parser step must still exist');
  assert.match(compiled, /PREEMPTED: \$\{\{ steps\.parse-mcp-gateway\.outputs\.ai_credits_rate_limit_error \}\}/);
  assert.match(compiled, /GH_AW_MAX_AI_CREDITS: "(\d+)"/);
  assert.equal(Number(/GH_AW_MAX_AI_CREDITS: "(\d+)"/.exec(compiled)![1]), policy.maxJobCredits);
});

test('every agent stage has a valid repository-scoped role profile', () => {
  const files = readdirSync('.github/agents');
  for (const stage of ['research', 'decompose', 'code', 'security', 'test', 'document', 'review']) {
    assert.ok(files.includes(`${stage}.agent.md`));
    const profile = parse(readFileSync(`.github/agents/${stage}.agent.md`, 'utf8').split('---')[1]!);
    assert.ok(profile.description.length > 30);
    assert.ok(profile.tools.length);
  }
});