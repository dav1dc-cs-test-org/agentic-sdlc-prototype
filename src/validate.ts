import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { policySchema, type Policy } from './contracts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const percentage = z.number().finite().min(0).max(100);
const coverageSchema = z.object({ total: z.object({
  lines: z.object({ pct: percentage }), branches: z.object({ pct: percentage }),
}) });
export type Coverage = z.infer<typeof coverageSchema>;

export function validateCoverage(baseline: unknown, candidate: unknown, policy: Policy): void {
  const before = coverageSchema.parse(baseline).total;
  const after = coverageSchema.parse(candidate).total;
  for (const metric of ['lines', 'branches'] as const) {
    if (after[metric].pct < policy.coverage[metric]) throw new Error(`${metric} coverage is below ${policy.coverage[metric]}%`);
    if (before[metric].pct - after[metric].pct > policy.coverage.maxDrop + 0.001) {
      throw new Error(`${metric} coverage regressed from ${before[metric].pct}% to ${after[metric].pct}%`);
    }
  }
}

export function validateAudit(input: unknown): void {
  const report = z.object({ metadata: z.object({ vulnerabilities: z.object({
    high: z.number().int().nonnegative(), critical: z.number().int().nonnegative(),
  }) }) }).parse(input);
  if (report.metadata.vulnerabilities.high || report.metadata.vulnerabilities.critical) {
    throw new Error('Dependency audit found high or critical vulnerabilities');
  }
}

export function validateSarif(input: unknown): void {
  const sarif = z.object({ runs: z.array(z.object({
    tool: z.object({ driver: z.object({ rules: z.array(z.object({
      id: z.string(), properties: z.record(z.string(), z.unknown()).optional(),
    })).default([]) }) }),
    results: z.array(z.object({
      ruleId: z.string().optional(), ruleIndex: z.number().int().nonnegative().optional(),
      level: z.string().optional(),
    })).default([]),
  })).min(1) }).parse(input);
  let blocking = 0;
  for (const run of sarif.runs) for (const result of run.results) {
    const rule = run.tool.driver.rules.find(rule => rule.id === result.ruleId) ??
      (result.ruleIndex === undefined ? undefined : run.tool.driver.rules[result.ruleIndex]);
    const severity = Number(rule?.properties?.['security-severity']);
    if (result.level === 'error' || !Number.isFinite(severity) || severity >= 7) blocking += 1;
  }
  if (blocking) throw new Error(`CodeQL found ${blocking} blocking or unclassified findings`);
}

export function validateSecrets(input: unknown): void {
  const findings = z.array(z.unknown()).parse(input);
  if (findings.length) throw new Error(`Secret scanning found ${findings.length} potential credentials`);
}

export function runTestSuite(directory: string, policy: Policy, reports: string): Coverage {
  const files = globSync(policy.testPaths, { cwd: directory }).sort();
  if (!files.length || files.length > 1000) throw new Error('No tests discovered or test-file limit exceeded');
  mkdirSync(reports, { recursive: true });
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'CI']
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const execute = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      cwd: directory, encoding: 'utf8', timeout: 600_000, maxBuffer: 4_000_000,
      env: environment,
    });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) throw new Error('Typecheck or test execution failed');
  };
  execute([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', join(directory, 'tsconfig.json')]);
  execute([join(root, 'node_modules/c8/bin/c8.js'), '--config', join(root, '.github/sdlc/coverage.json'),
    '--reports-dir', reports, '--temp-directory', join(reports, 'raw'),
    ...policy.sourcePaths.map(pattern => `--include=${pattern}`), process.execPath, '--test', ...files]);
  return coverageSchema.parse(JSON.parse(readFileSync(join(reports, 'coverage-summary.json'), 'utf8')));
}

if (import.meta.main) {
  const policy = policySchema.parse(JSON.parse(readFileSync(join(root, '.github/sdlc/policy.json'), 'utf8')));
  const command = process.argv[2];
  if (command === 'tests') {
    const candidate = resolve(process.argv[3] ?? 'source');
    const baseline = resolve(process.argv[4] ?? 'baseline');
    const reports = resolve(process.env.SDLC_COVERAGE_DIR ?? '.sdlc-output/coverage');
    const before = runTestSuite(baseline, policy, join(reports, 'baseline'));
    const after = runTestSuite(candidate, policy, join(reports, 'candidate'));
    validateCoverage(before, after, policy);
    console.log(`Coverage passed: lines ${after.total.lines.pct}%, branches ${after.total.branches.pct}%`);
  } else if (command === 'sarif') {
    const directory = process.argv[3]!;
    const files = readdirSync(directory).filter(file => file.endsWith('.sarif'));
    if (!files.length) throw new Error('CodeQL did not produce a SARIF report');
    for (const file of files) validateSarif(JSON.parse(readFileSync(join(directory, file), 'utf8')));
  } else if (command === 'audit') {
    validateAudit(JSON.parse(readFileSync(process.argv[3]!, 'utf8')));
  } else if (command === 'secrets') {
    validateSecrets(JSON.parse(readFileSync(process.argv[3]!, 'utf8')));
  } else throw new Error('Expected tests, sarif, audit, or secrets');
}