---
status: accepted
---

# Automated releases for the standalone CLI

The public `dotflowy` npm package has its own semver, changelog, Changesets
project, and release pipeline under `cli/`. App versioning and the app changelog
remain governed by [ADR 0046](./0046-changelog-and-release-versioning.md). The
CLI's package and compatibility contract remain governed by
[ADR 0061](./0061-cli-mcp-compatibility.md).

## A release PR is the publish approval

Packaged CLI behavior changes add a fragment under `cli/.changeset/`. Changes to
`cli/src/**`, the packaged `cli/README.md` or `cli/LICENSE`, or meaningful
published `cli/package.json` metadata fail CLI CI without one. The release PR's
version bump and development-only scripts/devDependencies are exempt, as are
tests and release machinery. Other repository docs do not invent a release. The
root app changeset remains a separate PR requirement.

On `main`, Changesets maintains one CLI release PR using a repository-scoped
GitHub App installation token. The app has only Contents and Pull requests
write access to this repository. The default `GITHUB_TOKEN` cannot maintain the
PR, and no personal access token is accepted. Changesets consumes CLI fragments,
bumps `cli/package.json`, and generates `cli/CHANGELOG.md` in that PR.

Merging the release PR is the human publish approval. There is no second approval
on the npm GitHub Environment. Branch protection must require all six CLI matrix
jobs: macOS, Linux, and Windows on Node 22 and 24. It must also require the
separate `CLI / changeset` check on ordinary PRs so the packaged-behavior gate
cannot be merged around. That check remains skipped/successful on the bot's
version-only release branch.

## Compatibility CI is wider than the package directory

The CLI speaks the Worker's MCP contract and shares concepts with client data
code. Changes under `cli/**`, `worker/**`, `src/data/**`, the root lockfile, or
either CLI workflow run the full six-job compatibility matrix. Every job builds,
typechecks, tests, and inspects the npm package. This is intentionally broader
than the set of paths that require a CLI changeset: compatibility can change
without changing the installed package.

## Publishing rebuilds and reconciles three durable records

After a release PR merge, a Linux Node 24 job installs from the frozen CLI lock,
then reruns build, typecheck, tests, and package inspection. npm authentication
uses Trusted Publishing bound to the exact `cli-release.yml` workflow and the
`npm` GitHub Environment. There is no long-lived npm publish token. Trusted
Publishing supplies provenance for this public package. The privileged job runs
only when Changesets selects `publish`, or for the explicit initial
`workflow_dispatch` reconciliation with a nonempty `bootstrap_commit`. A normal
`none` result never enters the npm Environment or receives write/OIDC permissions.

The job reconciles, in order:

1. the immutable `dotflowy@X.Y.Z` tag at the first-parent commit that introduced
   that version in `cli/package.json`;
2. the `dotflowy@X.Y.Z` publication on npm; and
3. a GitHub Release with the same tag and the generated changelog section.

If npm already contains the version, publishing is skipped. If the tag or release
is absent, it is created. If the tag exists at another commit, the job fails and
never moves it. This makes reruns repair partial releases without treating an
immutable package version as disposable metadata.

## `0.1.0` is a one-time bootstrap

npm cannot attach Trusted Publishing to an unclaimed package. A maintainer first
runs all publish checks and manually publishes `dotflowy@0.1.0` from a clean,
current `main` checkout with npm 2FA, recording that exact commit. Automation
explicitly refuses to publish an absent `0.1.0`. Configure Trusted Publishing,
disallow token publishing, and manually run `CLI Release` once with the recorded
commit as its `bootstrap_commit` input before another merge. The workflow then
reconciles the initial tag and GitHub Release. No synthetic `0.1.1` exists merely
to test the pipeline.

## Don't

Tie the CLI version to the app version; put CLI fragments in the root changeset
inbox; publish from a feature PR; use a PAT, npm token, or default `GITHUB_TOKEN`
for release-PR updates; add a second environment approval; move an existing CLI
tag; or create an empty CLI release to exercise automation.
