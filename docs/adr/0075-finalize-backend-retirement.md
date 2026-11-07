# Finalize backend retirement without deleting retained data

Status: accepted

Classic remains the only browser and MCP backend. Remove the alternate engine,
generated API, dependencies, optimistic planners, migration/recovery coordinator,
operator CLI, and tests that existed only for those modules. The daily plugin
imports its shared tree helpers directly from `tree.ts`.

The [cutover record](https://ampcode.com/threads/T-01a0fca6-b7b4-7578-9fb4-8743603b08de)
records all 233 accounts accounted for on October 3, 2026: 14 completed
cutovers/resolutions and 219 already on Classic, with no unresolved operations.
That supports application retirement, not permission to delete data. This
removal does not perform a new production audit or change production storage.

Keep the deployed `ShardDO` class, `SHARD` binding, and Wrangler migration tags.
`worker/retained-shard.ts` is a native storage custodian, not an alternate
backend: HTTP requests return 404, old alarms do no work, and no schema or jobs
initialize. Only the authenticated account-deletion lifecycle calls `wipe()`.
It uses the original user-id namespace and deletes SQL, KV, and alarms. Removing
the binding or adding a class-deletion migration needs separate approval.

Keep D1 migrations 0010, 0011, and 0013 byte-for-byte, including their historical
identifiers and filenames. Renaming applied migrations changes Wrangler's
application ledger; rewriting their tables would change the retained audit
contract. They are deliberate literal-reference exceptions, not runtime
dependencies. Do not drop audit tables, delete shard data, or delete R2 archives
or recovery manifests as part of application cleanup. Archived objects remain
outside the normal `backups/` lifecycle prefix. Export/recovery tooling now lives
in Git history; using it again requires a separately reviewed operator change.

Classic retains its persisted write-fence checks, snapshot resume floor, and
restore guards for existing cutover receipts. The two reads of the historical
retired-marker key and its regression fixture are compatibility exceptions:
changing the key without a data migration could permit a destructive restore
over recovered content.
No receipt, node, side-collection, old preference, or recovered folder is deleted
or rewritten. Old preferences can no longer select a backend because no runtime
selection exists.

The retired HTTP namespace has no handler; non-API URLs follow the normal
asset/SPA fallback. Auth, outline sync, MCP, capture, daily notes, off-site
backups, and account deletion remain on their existing paths.
