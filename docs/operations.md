# GitHub Setup and Operations

## Prerequisites

- A repository on GitHub.com with Actions enabled and permission to run the
  SHA-pinned actions used by the workflows.
- Copilot inference access. The agent workflow bills inference to an
  organization's Copilot subscription through the per-run Actions token, which
  requires an organization-owned repository with centralized Copilot billing.
  Step 2 describes the personal-account fallback. This implementation runs
  Copilot through Agentic Workflows, not issue assignment to the managed Copilot
  cloud agent.
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
repository. No separately hosted App server is required. Register the App under
the same account that owns the repository: a private App can only be installed on
its owner's account, so transferring either the App or the repository later
uninstalls it and every controller run then fails to mint a token. Give it these
repository permissions:

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
| `SDLC_MODEL` | Optional Copilot inference model ID; defaults to `auto` when unset or empty |

The App slug is used to authenticate worker runs. It must match the App that
mints the controller token; it is not the App's human-readable display name.
The controller compares this variable against the slug of the App it
authenticates as and fails the run when they differ. Without that check a stale
value leaves every dispatched worker skipping its own actor gate, stalling the
lifecycle with no failed run to investigate.

Configure `SDLC_MODEL` under **Settings > Secrets and variables > Actions >
Variables** with a model identifier supported by the Copilot runtime and enabled
for your organization. It applies to all seven SDLC agent stages and gh-aw's
threat-detection pass. Changes apply to subsequent workflow runs without editing
or recompiling workflows; remove the variable or leave it empty to restore `auto`.

## 2. Configure Environments

Create both environments before enabling the controller. Limit deployment
branches to this repository's default branch. Do not add a required reviewer
unless you intentionally want a human checkpoint on every job.

Each environment takes two calls: one to enable custom branch policies, one to
name the branch. Substitute your repository and default branch.

```sh
repo=OWNER/REPO
for environment in sdlc-controller sdlc-agent; do
  gh api -X PUT "/repos/$repo/environments/$environment" --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
  gh api -X POST "/repos/$repo/environments/$environment/deployment-branch-policies" \
    -f name=main -f type=branch
done
```

### sdlc-controller

Store `SDLC_APP_PRIVATE_KEY` as an environment secret. Only the trusted
controller references this environment. Do not also store this key as a
repository-wide secret: candidate workflows must not be able to request it.

### sdlc-agent

This environment holds no secrets. The [agent source](../.github/workflows/sdlc-agent.md)
sets `permissions.copilot-requests` to `write`, so inference uses the per-run
Actions token and bills through the organization's Copilot subscription. No
personal access token is created, stored, or rotated. The environment still
exists to restrict agent runs to the default branch.

This mode requires an organization-owned repository whose organization has a
Copilot subscription with centralized billing enabled. Confirm the organization's
Copilot policies permit it before enabling the controller.

If inference fails with `403`, the Actions token has no Copilot access for that
organization. To fall back, set `permissions.copilot-requests` to `none`,
recompile with the pinned compiler, and store `COPILOT_GITHUB_TOKEN` as an
environment secret here. That fallback needs a fine-grained token owned by a user
account rather than an organization, with Account permissions then Copilot
Requests set to read, following the
[Copilot engine authentication guide](https://github.github.io/gh-aw/engines/copilot/).
Read-only repository access uses the workflow token in either mode.

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
The included [.github/CODEOWNERS](../.github/CODEOWNERS) mirrors the protected
paths in [policy.json](../.github/sdlc/policy.json), so the surface agents cannot
touch also cannot reach the default branch unreviewed. Replace the owner handle
with a maintainer or team in your own account, then confirm GitHub resolves it:
`gh api "/repos/$repo/codeowners/errors"` reports unknown owners and owners
without write access, and an unresolvable owner silently disables the rule.

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

```sh
gh label create agentic-SDLC --repo "$repo" --color B60205 \
  --description "Approval-gated agentic delivery pipeline"
```

Harden the repository's Actions defaults. Every workflow here declares explicit
permissions, so nothing depends on the repository default, but a newly added or
contributed workflow would otherwise inherit write access and be able to approve
a pull request.

```sh
gh api -X PUT "/repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

On a public repository, require approval before a fork pull request can run any
workflow. Approving such a run executes contributed code on your runner. The
token is read-only and environment secrets stay unreachable, but the compute is
yours, so read the diff first.

```sh
gh api -X PUT "/repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors
```

Set Actions and inference spending limits. Set `SDLC_ENABLED` to `true` only
after the environments, App installation, label, and permissions are ready.
The editor may show unknown-context warnings for the variables and environments
until those GitHub settings exist.

### Verify before enabling

Scan the baseline with CodeQL and fix what it reports first. CodeQL analyses the
whole tree and `CI / Verify` does not run it, so any pre-existing finding at
`security-severity` 7 or above blocks every agent run from the first scan
onward, and agents cannot clear findings that sit in protected paths.

Then confirm the configuration reports what you expect:

```sh
gh api "/repos/$repo/actions/variables" --jq '.variables[] | "\(.name)=\(.value)"'
gh api "/repos/$repo/actions/secrets" --jq '.secrets[].name'
gh api "/repos/$repo/environments" --jq '.environments[].name'
gh api "/repos/$repo/environments/sdlc-agent/secrets" --jq '.secrets | length'
gh api "/repos/$repo/rulesets" --jq '.[].name'
gh api "/repos/$repo/codeowners/errors" --jq '.errors | length'
gh api "/repos/$repo/labels" --jq '[.[].name] | index("agentic-SDLC")'
gh api "/repos/$repo/contents/.github/workflows?ref=main" --jq '.[].name'
```

`SDLC_APP_PRIVATE_KEY` must not appear in the repository secret list, and the
`sdlc-agent` environment must hold zero secrets. Candidate workflows can request
repository secrets; they cannot request another environment's. All four
workflows must already exist on the default branch, and the codeowners and
label checks must return `0` and a non-null index respectively.

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
