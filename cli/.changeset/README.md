# CLI changesets

This is the standalone Changesets project for the public `dotflowy` npm
package. It is independent from the app's root `.changeset/` inbox and version.

From `cli/`, run `bun run changeset` for a change to packaged CLI behavior.
Choose the CLI semver bump and describe the effect on CLI users. Do not add an
empty CLI changeset for repository docs outside the packaged `cli/README.md`,
tests, or release-pipeline maintenance.

Merging the bot-maintained CLI release PR is the human approval to publish. The
release PR consumes these fragments and regenerates `cli/CHANGELOG.md`.
