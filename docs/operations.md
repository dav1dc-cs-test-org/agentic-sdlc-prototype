# GitHub Setup and Operations

## Prerequisites

- A repository on GitHub.com with Actions enabled and permission to run the
  SHA-pinned actions used by the workflows.
- A paid Copilot plan and permission to use Copilot CLI for inference. This
  implementation runs Copilot through Agentic Workflows, not issue assignment
  to the managed Copilot cloud agent.
- CodeQL availability. Private repositories need the appropriate GitHub Code
  Security entitlement. Missing scanner access is a blocking error, not an
  automatically waived security gate.
- Permission to configure repository variables, environments, and branch rules.
- A reviewed default-branch installation of the complete repository contents.

The built-in test harness targets Node.js/TypeScript, an npm lockfile, a
TypeScript configuration, and Node's test runner. Supporting a different stack
requires a reviewed validator and policy change before enabling agents.

## 1. Create a Controller App

Create a GitHub App with webhooks disabled and install it only on this
repository. No separately hosted App server is required. Give it these repository
permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Contents | Read and write | State branch and approved feature commits |
| Issues | Read and write | Intake, comments, task links, closure |
| Pull requests | Read and write | Final PR and advisory review |
| Actions | Read and write | Dispatch, cancel, and inspect registered workers |
| Checks | Read and write | Commit-bound completion check |
| Metadata | Read | Repository identity and permission queries |

Do not grant Administration permission. Do not give this App a bypass on the
default branch. Generate an App private key and enter it directly into GitHub's
secret configuration, never into an issue, prompt, committed file, or chat.

Create repository variables:

| Variable | Value |
| --- | --- |
| `SDLC_APP_ID` | Numeric App ID |
| `SDLC_APP_SLUG` | App slug, without the `[bot]` suffix |
| `SDLC_ENABLED` | `false` until all setup and checks are complete |

The App slug is used to authenticate worker runs. It must match the App that
mints the controller token; it is not the App's human-readable display name.

## 2. Configure Environments

Create both environments before enabling the controller. Limit deployment
branches to this repository's default branch. Do not add a required reviewer
unless you intentionally want a human checkpoint on every job.

### sdlc-controller

Store `SDLC_APP_PRIVATE_KEY` as an environment secret. Only the trusted
controller references this environment. Do not also store this key as a
repository-wide secret: candidate workflows must not be able to request it.

### sdlc-agent

Store `COPILOT_GITHUB_TOKEN` as an environment secret. Use a fine-grained token
with Copilot Requests access for an eligible user, following the
[Copilot engine authentication guide](https://github.github.io/gh-aw/engines/copilot/).
The token authenticates inference; read-only repository access uses the workflow
token separately.

For eligible organization-billed usage, administrators can instead enable the
required Copilot policies, set `permissions.copilot-requests` to `write` in the
[agent source](../.github/workflows/sdlc-agent.md), and recompile it. The default
is explicitly `none`, using the configured Copilot token. Verify billing and
policy support before switching modes.

The generated workflow uses sandbox containers on GitHub-hosted runners. Docker
is not a local development requirement. Do not run untrusted candidate tests
on a persistent runner with organization credentials or access to production.

## 3. Protect Branches

Every command below assumes these two values. For `Integration` bypass actors,
`actor_id` is the numeric App ID, not the installation ID.

```sh
repo=OWNER/REPO
app=$(gh api "/repos/$repo/actions/variables/SDLC_APP_ID" --jq .value)
```

Create both `sdlc-state` rulesets before the branch's first creation, because
`creation` is only evaluated when the branch does not yet exist. The state
branch needs two rulesets rather than one: bypass is granted per ruleset, not
per rule, so a single ruleset would also hand the App the deletion and
force-push rights it must never hold. Rules aggregate across rulesets, so the
split leaves the App able to create and push state commits while staying bound
by the locks. The controller initializes this branch with an isolated root
commit and maintains an auditable JSON history; it never deletes or rewrites it.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<JSON
{
  "name": "sdlc-state controller writes",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{ "actor_id": $app, "actor_type": "Integration", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/sdlc-state"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }]
}
JSON
```

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<'JSON'
{
  "name": "sdlc-state immutable history",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/sdlc-state"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }]
}
JSON
```

Do not require a PR for state updates, and do not require signed commits on
either ruleset. The isolated root commit carries no signature, so a signing rule
in the unbypassed ruleset permanently blocks branch creation.

For the default branch, require pull requests, `CI / Verify`, and human review.
Protect automation and policy changes with code-owner or designated maintainer
review. Do not permit the controller App to bypass these requirements.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<'JSON'
{
  "name": "default branch protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "CI / Verify" }] } }
  ]
}
JSON
```

Code-owner review only takes effect once the repository has a `CODEOWNERS` file.

In a dedicated pipeline-only sandbox, also require `SDLC / Complete` and select
the controller App as its expected source after the first pilot check appears.
This check is deliberately absent on unprocessed commits. Requiring it for all
PRs also blocks manually authored maintenance PRs; handle those through an
explicit human governance policy, never an automatic App bypass.

Restrict updates to `agentic/epic-*` branches to the controller where practical.
Changes made outside a registered job stop automatic integration. Changes after
the final PR is published do not inherit evidence from its old head commit.

```sh
gh api -X POST "/repos/$repo/rulesets" --input - <<JSON
{
  "name": "agentic epic branches",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [{ "actor_id": $app, "actor_type": "Integration", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["refs/heads/agentic/epic-*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }]
}
JSON
```

Do not lock deletions on that pattern. A new plan version starts a new branch and
preserves the previous one, so superseded branches accumulate and need cleanup.

Confirm the result with `gh api "/repos/$repo/rulesets"`. On an organization-owned
repository, organization rulesets layer on top of these and repository admins
cannot bypass them; check the organization's rules for conflicting targets.

Disable automatic merge. The prototype only creates a merge-ready PR; it does
not decide whether humans should merge it.

## 4. Install and Enable

Run the local verification in the [README](../README.md). Review the Markdown
workflow and generated lockfile, then commit and push them to the default branch.
The controller and worker workflows must all exist on that branch before
dispatch can work. If the default branch is not `main`, update the push filter
in [CI](../.github/workflows/ci.yml) as part of installation.

Create the `agentic-SDLC` label in the repository. Optionally use the included
[issue form](../.github/ISSUE_TEMPLATE/agentic-feature.yml); automatic labels on
the form still require the label to exist and the labeler to have write access.

Set Actions and inference spending limits. Set `SDLC_ENABLED` to `true` only
after the environments, App installation, label, and permissions are ready.
The editor may show unknown-context warnings for the variables and environments
until those GitHub settings exist.

First intake requires an `issues:labeled` event sent by a human with current
write access. Schedules and manual dispatches reconcile durable state but do not
create a lifecycle from a pre-existing label. If an issue was labeled while the
controller was disabled, remove the label and have a writer reapply it.

## 5. Run a Bounded Pilot

Use a small change with explicit acceptance criteria in an allowed application
path. For this repository, a documentation-only change or a new independently
tested module under a subdirectory is a suitable first pilot; the controller
source and existing baseline tests are protected.

1. Have a repository writer apply `agentic-SDLC` to the issue.
2. Confirm the issue receives a status comment and a proposed plan.
3. Request one revision with a new `/sdlc revise ...` comment.
4. Confirm that approving the old version is rejected.
5. Approve the current version with a new `/sdlc approve vN` comment.
6. Observe native sub-issues, sequential coding, scans, security review, testing,
   coverage comparison, and independent review.
7. Confirm no feature PR exists before all gates pass.
8. Inspect the final PR's plan hash, current-commit evidence, advisory review,
   and `SDLC / Complete` check. Review and merge it yourself.
9. Confirm the epic and child tasks close after merge.

Also test pausing an in-flight job and a deliberately failing test on a disposable
pilot. Do not treat local mocks as evidence that live credentials, billing,
network policies, CodeQL licensing, or Copilot behavior work in your organization.

## Recovery

Controller runs are serialized. Actions may coalesce pending events; every
10 minutes the schedule rereads durable state and issue commands. It can also
be run manually from the Actions tab, optionally for one issue.

- A lost dispatch is rediscovered by job identity, actor, and workflow revision,
  then retried within policy if no run appears.
- A transient `404`, `408`, `429`, rate-limited `403`, or `5xx` while retrieving
  a completed worker artifact, or a successful listing where that artifact is
  not visible yet, preserves the registered job for another reconciliation. If
  retrieval remains unavailable past the job timeout, it consumes one
  infrastructure failure.
- A transient failure after a branch write can recover the matching commit.
  Do not manually rewrite the state file to work around a failed run.
- A failed scanner or test produces repair feedback; a missing or malformed
  result is an infrastructure failure. Both paths are bounded.
- A blocked lifecycle needs investigation. Use `/sdlc retry` for the registered
  stage only after correcting the cause. Do not use GitHub's rerun button on
  worker jobs: rerun attempts are deliberately excluded from trusted results.
- If the default branch or issue scope changes, use `/sdlc revise ...` and
  approve the new plan. Earlier branches remain available for inspection.
- Cancellation invalidates in-flight results before requesting cancellation of
  the worker run. A late artifact cannot restart the cancelled lifecycle.

`SDLC_ENABLED=false` prevents new controller transitions and worker starts.
For an immediate emergency stop, also cancel in-progress controller and worker
runs in Actions. Removing the label or closing the issue cancels that lifecycle.

Logs and artifacts are retained according to Actions policy; worker evidence
artifacts request 14-day retention. Durable state and issue/PR summaries retain
the links, not perpetual copies of expiring artifacts. Adjust retention for
your audit needs through a reviewed workflow change.
