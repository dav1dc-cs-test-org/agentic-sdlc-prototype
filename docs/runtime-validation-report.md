# State Migration Validation

Date: 2026-09-11. Scope: the local version-2 lifecycle migration and its tests,
before deployment. No live state writes, configuration changes, commits, or
pushes were performed during validation.

## Results

The earlier total of 100 passing tests was for the whole repository, not 100
migration-specific tests. This additional pass added 11 runnable tests and more
malformed-input cases in the existing test files. No further production-code
changes were needed during this pass.

| Check | Result | Exit Code |
| --- | --- | --- |
| Node 24.20.0: clean install, typecheck, coverage tests, build | 111 passed, 0 failed, 0 skipped | 0 |
| Node 26.8.2: typecheck, coverage tests, build | 111 passed, 0 failed, 0 skipped | 0 |
| Editor diagnostics for changed tests | No errors | N/A |
| Previously failing issue #1, read-only local migration | Version 1 loads as version 2, lifecycle fields preserved | 0 |

Overall repository coverage on both runtimes: 94.76% lines and 87.81% branches.
The controller entry point has 100% line coverage and 92.68% branch coverage.
Coverage thresholds and security policy were not lowered.

## Scenarios Covered

- Valid version-1 state with and without costs, current-version state, exact
  preservation of lifecycle data, and repeated load/save/reload.
- Missing or malformed cost fields, invalid numeric values, unknown schema
  versions, unexpected fields, and state/issue identity mismatches.
- The real controller and GitHub adapter together: an open PR requires exactly
  one state upgrade and one status-comment update across fresh controller runs.
  Unexpected API operations fail the test.
- Stale state-file SHAs, denied writes, interrupted writes, and lost commit
  acknowledgements. Replays do not duplicate a committed migration.
- Exactly-once cost charging, preserved receipts, and partial-history warnings
  that survive retries and replanning.
- Untrusted approval commands, changed trusted revisions, stale controller
  code, and late worker results. Migration does not bypass those checks.
- The actual controller CLI in fresh subprocesses: mixed legacy/current/corrupt
  batches, closed issues, targeted runs, supported event routing, PR-event
  exclusion, invalid issue inputs, and missing credentials.
- Worker reads of legacy state without granting state-write permission.

The tests live in [../test/contracts.test.ts](../test/contracts.test.ts),
[../test/controller.test.ts](../test/controller.test.ts),
[../test/github.test.ts](../test/github.test.ts), and
[../test/worker.test.ts](../test/worker.test.ts).
The standard `npm run verify` command includes them all.

## Limits and Rollout

These are unit, mocked integration, and process-level CLI tests on macOS.
GitHub HTTP is intercepted; subprocesses receive dummy credentials and an
explicit environment allowlist. Docker, a local service, and browser testing
are not applicable to this Actions controller. This is not a hosted GitHub
end-to-end test: live App permissions, Ubuntu runner behavior, and actual
concurrent Actions jobs remain unverified by this pass.

The live `SDLC_ENABLED` variable was `true` when checked. Before pushing, set it
to `false` and drain older runs. Deploy, re-enable, and start a new controller
run following [operations.md](operations.md#state-upgrades). The migration
must not be treated as a reason to bypass normal approval or revision gates.
