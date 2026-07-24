import { Effect } from "effect";

import {
  isSyncReady,
  nodesCollection,
  nodesLoadError,
  subscribeSyncReady,
} from "./collection";
import { BootstrapError } from "./errors";
import { isLunoraSyncEnabled } from "./flags";
import { appendChild } from "./mutations";
import { createId, makeNode, now } from "./tree";

/** Wait until the shell's sync-ready signal flips (custom DO or Lunora). */
function waitUntilSyncReady(): Promise<void> {
  if (isSyncReady()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = subscribeSyncReady(() => {
      unsub();
      resolve();
    });
  });
}

// One-shot guard, set synchronously before the first await. bootstrapOutline is
// the single mount entry point; this guard means React StrictMode's
// double-mounted effect can't run two competing seed chains on the same empty
// collection.
let bootstrapped = false;

/**
 * First-run bootstrap: seed the welcome bullets when the outline is genuinely
 * empty (a brand-new account). There is no client-side data migration — a
 * returning owner's pre-DO outline is carried over SERVER-side by the Worker
 * (`ensureSeeded` in worker/index.ts copies the legacy D1 rows into the owner's
 * DO on first read). The old localStorage import was removed: localStorage is
 * browser-scoped, but accounts are per-user, so importing it would leak one
 * browser's leftover outline into every new account that signs in there. Called
 * once on mount; see docs/adr/0008-sync-via-a-per-user-durable-object.md.
 *
 * Bail BEFORE seeding if the initial sync failed. The custom-sync adapter calls
 * markReady() even when the socket can't reach the server, so `toArrayWhenReady()`
 * resolves EMPTY rather than rejecting (see nodesLoadError) -- without this gate
 * a returning user who opens the app during a server outage would have welcome
 * bullets seeded over their real (just-unreachable) outline. We surface the
 * failure as a value (not a throw); the caller logs it.
 */
export async function bootstrapOutline(): Promise<BootstrapError | void> {
  if (bootstrapped) return;
  bootstrapped = true;

  // ADR 0055: Lunora path seeds via `seedIfEmpty` mutator in lunora-sync.
  // Just wait for wholeOutline ready so the editor doesn't race an empty feed.
  if (isLunoraSyncEnabled()) {
    return Effect.runPromise(
      Effect.match(
        Effect.tryPromise({
          try: () => waitUntilSyncReady(),
          catch: (cause) => new BootstrapError({ cause }),
        }),
        {
          onFailure: (error) => error,
          onSuccess: () => undefined,
        },
      ),
    );
  }

  // One Effect program. Wait for the first load (tryPromise covers the rare
  // synchronous sync-init throw); then the typed-failure gate — if the sync
  // failed (the common 500/offline case settles ready-but-empty with the error
  // recorded in nodesLoadError), fail with BootstrapError rather than seed over
  // an unreachable outline; otherwise seed-if-empty.
  const program = Effect.tryPromise({
    try: () => nodesCollection.toArrayWhenReady(),
    catch: (cause) => new BootstrapError({ cause }),
  }).pipe(
    Effect.flatMap(() => {
      const loadError = nodesLoadError();
      return loadError
        ? Effect.fail(new BootstrapError({ cause: loadError }))
        : Effect.tryPromise({
            try: () => seedIfEmpty(),
            catch: (cause) => new BootstrapError({ cause }),
          });
    }),
    Effect.asVoid,
  );
  // Fold the typed failure back to a VALUE at this mount-time boundary
  // (BootstrapError | void, which the caller checks) — not a throw, since this
  // isn't a TanStack handler. The Effect runs underneath; only the seam differs.
  // See docs/adr/0021-effect-first-one-schema-language.md.
  return Effect.runPromise(
    Effect.match(program, {
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  );
}

// One-shot guard, set synchronously before the first await. The old
// localStorage seed was synchronous, so a double-mounted effect saw the
// just-written rows and skipped. The D1 path is async: two effect invocations
// (StrictMode / Start's dev client re-mount) would both await an empty
// collection and both seed. This flag closes that race — the second caller
// bails before inserting. Module-scoped, so it survives a component remount.
let seedStarted = false;

/**
 * Seed the outline on first run. Idempotent and async-safe: it awaits the
 * collection's initial load (`toArrayWhenReady`) before deciding, so it only
 * seeds when the server genuinely has no nodes for this user — never on the
 * brief "empty before the first sync resolves" window. Returns true if it
 * seeded, false otherwise.
 *
 * The failed-sync case is handled upstream in bootstrapOutline. By the time
 * bootstrap calls us the collection is already ready, so this await resolves
 * instantly.
 *
 * The component calls this once on mount; the inserts persist through the
 * collection's normal mutation path. See docs/adr/0008-sync-via-a-per-user-durable-object.md.
 */
async function seedIfEmpty(): Promise<boolean> {
  if (seedStarted) return false;
  seedStarted = true;

  const existing = await nodesCollection.toArrayWhenReady();
  if (existing.length > 0) return false;

  // Three sibling top-level bullets, one with a child, so the user lands
  // on something that demonstrates the structure immediately.
  const aId = createId();
  const bId = createId();
  const cId = createId();

  nodesCollection.insert(
    makeNode({
      id: aId,
      parentId: null,
      prevSiblingId: null,
      text: "Welcome to Dotflowy",
      createdAt: now(),
    }),
  );
  nodesCollection.insert(
    makeNode({
      id: bId,
      parentId: null,
      prevSiblingId: aId,
      text: "Press Enter to add a bullet",
    }),
  );
  nodesCollection.insert(
    makeNode({
      id: cId,
      parentId: null,
      prevSiblingId: bId,
      text: "Tab indents, Shift+Tab outdents, Backspace on empty deletes",
    }),
  );

  // A child under the welcome bullet to show nesting.
  appendChild(
    aId,
    null,
    "This is a sub-bullet. Collapse its parent with the dot.",
  );

  return true;
}
