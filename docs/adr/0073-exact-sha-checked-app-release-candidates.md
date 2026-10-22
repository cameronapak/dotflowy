---
status: accepted
---

# Check the exact app release candidate before promoting it

The app release workflow creates a commit after its quality checks, then pushes
that commit with `GITHUB_TOKEN`. The new SHA has no CLI checks. Enforcing the
seven checks in [ADR 0062](./0062-automated-cli-releases.md) would reject that
push. Checking the parent or changing a checkout inside the original workflow
does not attach native check records to the generated commit.

This design preserves the approval and authentication model in
[ADR 0046](./0046-changelog-and-release-versioning.md): an ordinary merge approves
automatic app release and deployment. A temporary branch gives the generated
commit its own real CLI workflow run before promotion. There is no bypass, new
credential, or second app release PR.

Cam delegated the remaining design choices to the agent, favoring robustness
without unnecessary optimization, confirmed the resulting design, and authorized
implementation. Remote configuration changes, deployment rehearsals, merging PR
#422, and npm 0.2.0 publication require separate authorization. The release
holds remain in place.

## Candidate identity and promotion

A release candidate is the exact commit prepared and built for app deployment,
not a branch name or an npm package version. Its base is the immutable main SHA
selected before quality checks. The candidate is either that base, when there
is no app news, or the app release commit directly atop it.

1. Keep the existing production concurrency group and current-main selection.
   Run the existing full app quality workflow against the selected base.
2. Prepare the app release and build both sites as today. Keep the generated tag
   local. Do not publish a GitHub Release or deploy either site yet.
3. Push only the candidate to a unique temporary branch, named with the parent
   workflow run ID and attempt. Never reuse, update, or force-push that branch.
   Use the same protocol when there is no news; do not manufacture a commit or
   version bump.
4. Explicitly dispatch `.github/workflows/cli.yml` with that branch as the actual
   workflow ref. Pass the captured base SHA for the changeset comparison. Check
   out the event SHA, not an independently supplied candidate checkout ref.
5. Capture the dispatched run ID. GitHub's documented workflow-dispatch API can
   return it; use an explicit supported API version. An ambiguous or missing
   response stops the parent rather than causing a blind redispatch.
6. Wait for that run with a bounded deadline. Verify its repository, workflow,
   dispatch event, branch, and head SHA. Require all six expected matrix jobs and
   the changeset job to conclude `success` in that run's completed attempt. A
   green overall conclusion alone is insufficient: missing, skipped, neutral,
   failed, cancelled, or timed-out jobs all stop promotion. Do not borrow a
   result from another run or SHA.
7. Confirm main still equals the captured base and the temporary branch still
   identifies the checked candidate. Atomically push that identical commit and
   the app tag to main with the existing non-force push. The push remains the
   final concurrent-merge guard. Never rebase, recreate, or amend a checked and
   built candidate.
8. Publish the GitHub Release, then deploy the existing landing and app builds,
   in their existing order, and run the existing public health checks.

Start with a 45-minute validation deadline, including queue time, and a
75-minute parent deploy-job timeout to leave room for builds and deployment.
The validation workflow must not share the parent's production concurrency
group, which would deadlock the wait. Do not automatically retry failing tests.

The candidate branch is disposable, not a release record. Attempt to delete only
that attempt's branch on success or failure, after validation has settled. If a
parent is cancelled, cancel its known validation run before cleanup when
possible. Report cleanup failures without hiding the release outcome. An
orphan branch is safe; do not add a janitor service or delete branches belonging
to other attempts. Retain workflow logs, run URLs, and candidate/base SHAs for
diagnosis even after deleting the branch.

## One real CLI gate

Remove PR path filtering from `cli.yml`. Every PR runs the six real OS/Node jobs
and the real changeset checker. Keep the narrower main-push filters; candidate
validation uses an explicit dispatch and is not dependent on push events.

Run the changeset checker on release PRs too. Its existing published-manifest
comparison excludes version-only and development-only changes, so those PRs
succeed without inventing a CLI fragment. This replaces the branch-name skip
with the existing content-based exemption; it does not remove that exemption.
An app candidate compares against its captured base, not moving `origin/main`.
The dispatched workflow verifies that base is in main's history and that the
event SHA equals the base or is its direct child. It must reject an arbitrary
comparison base rather than letting a caller hide changes by passing the
candidate itself. Its real checker normally reports that no packaged CLI
behavior changed.

Use the existing six matrix jobs and their build, typecheck, test, and package
inspection commands. Do not add synthetic success contexts, a second copy of
the matrix, or a generic validation framework. Full app quality remains on the
base; both sites build after release generation. This design does not add
another full app browser run on generated changelog/version metadata.

## Permissions and branch policy

Keep `GITHUB_TOKEN` for candidate branches, promotion, tags, and app GitHub
Releases. Add job-scoped `actions: write` only to the parent job that dispatches,
observes, and can cancel candidate validation. Validation retains read-only
repository permissions, does not persist checkout credentials, receives no
release secrets, and never enters the `npm` environment or requests OIDC.
Cloudflare authentication remains unchanged.

The CLI release App remains limited to maintaining its release PR. npm remains
Trusted Publishing from `cli-release.yml`, environment `npm`, branch `main`.
Candidate validation does not dispatch CLI publication. App token-generated
pushes remain nonrecursive; only the explicit validation dispatch creates a run.

Require these existing check contexts on main, bound to the verified GitHub
Actions producer (App ID 15368):

- `test (ubuntu-latest, 22)`
- `test (ubuntu-latest, 24)`
- `test (macos-latest, 22)`
- `test (macos-latest, 24)`
- `test (windows-latest, 22)`
- `test (windows-latest, 24)`
- `changeset`

Use strict up-to-date checking and apply protection to administrators too. Allow
no bypass, force push, or main deletion. Do not add PR-required, signed-commit,
linear-history, deployment, or push-actor restrictions as part of this change;
they are separate policies and can conflict with direct promotion. In
particular, this gate does not claim to prevent every checked direct push by a
repository writer. Do not silently add `quality` as an eighth required context:
requiring it on generated release commits needs its own compatible design.

## Failure, retry, and rollout boundaries

- If validation fails, goes missing, or exceeds its deadline, stop before remote
  tag publication, GitHub Release publication, or either deployment.
- If main advances before promotion, discard the stale candidate. The queued
  run selects current main and starts again. Do not retry by changing its SHA.
- After promotion, finish the active deployment even if another merge arrives,
  as the existing serialized production model requires.
- If publication or deployment fails after promotion, retain the existing
  no-rollback behavior. A fresh main workflow run revalidates, rebuilds, and
  reuses immutable release records when there is no new news. Never move a
  conflicting existing tag. Landing and app may temporarily differ.
- Do not activate the seven requirements until universal PR coverage and the
  candidate protocol are on main and hosted checks demonstrate the expected
  SHA and contexts. Verify enforced promotion and rejection on an explicitly
  authorized disposable protected branch before relying on main enforcement.
  Do not experiment with a bypass or temporarily weaken main's requirements.
- Cover unrelated PRs, version-only CLI release PRs, app news, no news, stale
  main, failed/missing/skipped validation, cancellation, and partial-release
  retries. Local Git fixtures can establish atomicity and race rejection;
  hosted evidence is necessary for GitHub check attribution and enforcement.
- Update ADRs 0046/0062, the deployment guide, and contributor setup instructions
  alongside implementation. Do not claim hosted verification from local tests.
  Read back branch protection and the npm environment after any authorized
  configuration change.

PR #422 remains open and npm 0.2.0 remains unpublished through this work.
Successful validation does not establish npm Trusted Publishing: that remains
unverified until a separately authorized real publication succeeds.

## Evidence

The current workflows and release script establish the local behavior:
[`deploy.yml`](../../.github/workflows/deploy.yml),
[`cli.yml`](../../.github/workflows/cli.yml), and
[`release.ts`](../../scripts/release.ts). GitHub documents the
[`workflow_dispatch` token exception](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow),
the [dispatch ref and SHA](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch),
the [dispatch response](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
and [protected-branch check requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
These support the design; the hosted protocol has not been exercised here.
