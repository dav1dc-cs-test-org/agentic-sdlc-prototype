import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { policySchema } from '../src/contracts.ts';
import { runTestSuite, validateAudit, validateCoverage, validateSarif, validateSecrets } from '../src/validate.ts';

const policy = policySchema.parse(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')));
const coverage = (lines: number, branches: number) => ({ total: { lines: { pct: lines }, branches: { pct: branches } } });

test('coverage must meet fixed thresholds and cannot regress against the baseline', () => {
  assert.doesNotThrow(() => validateCoverage(coverage(85, 75), coverage(90, 80), policy));
  assert.throws(() => validateCoverage(coverage(90, 80), coverage(85, 75), policy), /regressed/);
  assert.throws(() => validateCoverage(coverage(60, 50), coverage(79, 75), policy), /below/);
  assert.throws(() => validateCoverage({}, coverage(90, 80), policy));
  assert.throws(() => validateCoverage(coverage(90, 80), coverage(NaN, 80), policy));
});

test('dependency audit cannot pass with missing data or high-severity vulnerabilities', () => {
  assert.doesNotThrow(() => validateAudit({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }));
  assert.throws(() => validateAudit({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }), /vulnerabilities/);
  assert.throws(() => validateAudit({ error: 'Network unavailable' }));
});

test('CodeQL findings are evaluated from rule metadata, not agent opinion', () => {
  const clean = { runs: [{ tool: { driver: { rules: [{ id: 'injection', properties: { 'security-severity': '8.1' } }] } }, results: [] }] };
  assert.doesNotThrow(() => validateSarif(clean));
  assert.throws(() => validateSarif({ runs: [] }));
  assert.throws(() => validateSarif({ runs: [{ ...clean.runs[0], results: [{ ruleId: 'injection', level: 'warning' }] }] }), /blocking/);
  assert.throws(() => validateSarif({ runs: [{ ...clean.runs[0], results: [{ ruleId: 'unknown' }] }] }), /unclassified/);
  assert.doesNotThrow(() => validateSarif({ runs: [{ tool: { driver: { rules: [
    { id: 'low', properties: { 'security-severity': '3.0' } },
  ] } }, results: [{ ruleIndex: 0, level: 'warning' }] }] }));
});

test('secret findings and malformed scanner output block the gate', () => {
  assert.doesNotThrow(() => validateSecrets([]));
  assert.throws(() => validateSecrets([{ RuleID: 'credential' }]), /potential credentials/);
  assert.throws(() => validateSecrets({ success: true }));
});

test('the test runner executes real tests and measures their coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sdlc-tests-'));
  try {
    mkdirSync(join(directory, 'src'));
    mkdirSync(join(directory, 'test'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true }, include: ['src'] }));
    writeFileSync(join(directory, 'src/add.js'), 'export const add = (first, second) => first + second;\n');
    writeFileSync(join(directory, 'test/add.test.js'),
      'import assert from "node:assert/strict"; import test from "node:test"; import { add } from "../src/add.js"; test("adds", () => assert.equal(add(2, 3), 5));\n');
    const fixturePolicy = { ...policy, testPaths: ['test/*.test.js'], sourcePaths: ['src/*.js'] };
    const measured = runTestSuite(directory, fixturePolicy, join(directory, 'coverage'));
    assert.equal(measured.total.lines.pct, 100);
    writeFileSync(join(directory, 'test/add.test.js'), 'throw new Error("regression");\n');
    assert.throws(() => runTestSuite(directory, fixturePolicy, join(directory, 'failed')), /execution failed/);
    assert.throws(() => runTestSuite(directory, { ...fixturePolicy, testPaths: ['missing/*'] }, join(directory, 'empty')), /No tests/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});