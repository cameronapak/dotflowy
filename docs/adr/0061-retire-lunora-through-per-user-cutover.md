# Retire Lunora through per-user cutover

Status: accepted

Lunora is retired by migrating each user independently from a frozen Lunora snapshot into the classic Durable Object, then switching that user to classic before writes resume. This supersedes ADR 0058's planned Lunora cutover: classic remains the only user-facing outline backend, while Lunora shards stay retained and read-only through the observation period.

Every Better Auth user is inspected from D1's authoritative user list. Preference-off users remain on classic; a preference-off user with Lunora data requires manual review because either backend might contain the newer edits. A Lunora snapshot is eligible for automatic migration only when one consistent, versioned export contains every Lunora table, has at least one node, passes row schemas and ownership checks, and has valid unique keys, references, and complete acyclic sibling chains.

Migration metadata and attempts live in D1. Immutable pre-migration classic and Lunora snapshots live in R2 under a unique migration id and must survive write-read validation before classic changes. Failed or manual-review users prevent the 30-day observation period from starting; deleting migration backups, Lunora bindings, or shard data is a separate infrastructure change that requires explicit approval.

Both backends freeze writes before export so an override or stale tab cannot race the restore. The restored classic snapshot takes nodes and the three shared side-collections from Lunora, preserves classic-only changelog and account preferences, stamps a resume barrier so older clients receive the replacement snapshot, and disables the Lunora preference before classic resumes. A preference-off user with Lunora data is classified `backend-conflict` and never migrated automatically.

Operator HTTP operations stay one-user and idempotent; a dry-run-first Bun CLI owns batching. If post-restore verification fails, the operator restores and verifies the immutable classic backup and leaves both backends frozen whenever the resulting state is uncertain. Migration tooling ships before runtime removal; after every eligible user is safely on classic, a separate application release removes the toggle and normal Lunora browser and MCP paths while retaining the read-only shard and export binding for the observation period.

The per-user operation is a resumable state machine with one durable migration id across D1, R2, Lunora, and classic. It freezes and exports classic first, freezes and exports Lunora second, verifies both immutable R2 objects, atomically restores classic with the migration id, verifies the complete restored snapshot, marks Lunora retired, and unfreezes classic. A retry resumes that operation; a completed user is a no-op. Failures before classic changes release both freezes, a verified rollback may also release them, and an uncertain state remains frozen for operator recovery.

An operator restore after Lunora is already retired restores the pre-migration classic content but keeps the Lunora preference disabled. A retired shard cannot be reopened, and restoring its old enabled preference would route MCP and reconnecting clients back to a permanently frozen backend.

The migration adds no temporary synchronization between backends. Connected Lunora clients learn the shard is retired and reload onto classic only after classic verification; the permanent server-side freeze remains the safety boundary. Report classifications add `backend-conflict` and `classic-invalid` where the proposed vocabulary could not describe a safe automatic action. Reports and logs contain stable user ids, state, counts, hashes, timestamps, snapshot keys, and failure reasons, but never node text.
