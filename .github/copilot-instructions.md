# Repository Instructions

- This repository implements a GitHub Actions controller, not a locally hosted
  service. Use Node.js 24.8 or newer. Local Docker is not required.
- Run `npm ci --ignore-scripts` and `npm run verify` after code changes. Tests
  must use local fixtures or mocked GitHub responses, never live write calls.
- Use the pinned gh-aw v0.88.7 compiler for agent workflow changes. Commit the
  Markdown source, generated lockfile, and action lock changes together.
- Keep the controller deterministic. Agents propose changes and reports; they
  do not approve plans, publish branches, weaken gates, or merge PRs.
- Bind every accepted result to its registered job, approved plan, trusted
  workflow revision, and source commit. New code invalidates older evidence.
- Keep publishing credentials in the controller environment. Never execute
  candidate code in a job that has the controller App token or private key.
- Preserve state-write concurrency checks and idempotent side effects. Add
  regression tests for retries, interruption, stale results, and authorization.
- Update README.md and the affected docs in the same commit when stages, phases,
  policy, workflows, permissions, or trust boundaries change. The pipeline's own
  documentation stage cannot cover this: protected paths are edited directly.
- Re-read every Mermaid diagram in docs/architecture.md against the change, not
  only the one that looks relevant. Edge labels and sequence steps that state a
  rule go stale silently. Validate with `mmdc --input <file> --output
  <tmp>/preview.md --outputFormat svg`, run outside the repository.
- Never lower coverage or security thresholds to accommodate a failing change.
  Do not automatically waive scanner findings or skip required checks.
- Do not push, create live resources, change GitHub settings, or expose secrets
  without the user's explicit authorization for that operation.
