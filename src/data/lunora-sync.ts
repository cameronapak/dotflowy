/**
 * Lunora outline sync lifecycle for the ADR 0058 flag-swap (default OFF).
 *
 * When `isLunoraSyncEnabled()`:
 * - creates `@lunora/db` `wholeOutline` collection + bound mutators
 * - feeds ADR 0004 `tree-store` from collection rows
 * - marks sync ready (shell spinner) + `seedIfEmpty` when the outline is empty
 *   AFTER auto-migrate from classic DO settles (success or skip)
 *
 * SPA/no-SSR: never start during prerender. Custom `/api/sync` stays cold
 * (see `collection.ts` early-return when the flag is ON).
 */

import {
  bindLunoraDailyIndex,
  unbindLunoraDailyIndex,
} from "../plugins/daily/daily-index";
import { noteAgentAnswerArrive } from "./agent-arrive";
import { bindLunoraAgentRuns, unbindLunoraAgentRuns } from "./agent-runs";
import { markNodesSyncReady } from "./collection";
import { isLunoraSyncEnabled } from "./flags";
import { outlineNodeToNode, rowsToOutlineNodes } from "./lunora-bridge";
import { getLunoraClient } from "./lunora-client";
import {
  installMigrateConsoleHelper,
  maybeAutoMigrateToLunora,
} from "./lunora-migrate";
import { createOutlineStore, type OutlineStore } from "./lunora-outline-store";
import { shouldSeedOutline, seedEmptyOutline } from "./outline-plans";
import { notifySaveFailed } from "./save-failure";
import {
  bindLunoraSavedQueries,
  unbindLunoraSavedQueries,
} from "./saved-queries";
import { bindLunoraTagColors, unbindLunoraTagColors } from "./tag-colors";
import { resetTreeFromNodes } from "./tree-store";

export type LunoraOutlineContext = {
  userId: string;
  store: OutlineStore;
};

let ctx: LunoraOutlineContext | null = null;
let collectionSub: { unsubscribe: () => void } | null = null;
let seedStarted = false;

/** Active Lunora outline context, or null when flag OFF / not started. */
export function getLunoraOutlineContext(): LunoraOutlineContext | null {
  return ctx;
}

function feedTreeFromCollection(store: OutlineStore): void {
  const nodes = rowsToOutlineNodes(store.collection.toArray).map(
    outlineNodeToNode,
  );
  resetTreeFromNodes(nodes);
}

/**
 * Start Lunora outline sync for `userId`. Idempotent for the same user.
 * No-op when the flag is OFF or during SSR.
 */
export function startLunoraOutlineSync(userId: string): void {
  if (!isLunoraSyncEnabled()) return;
  if (typeof window === "undefined") return;
  if (ctx?.userId === userId) return;

  stopLunoraOutlineSync();

  const store = createOutlineStore(getLunoraClient(), userId);
  ctx = { userId, store };

  // Phase 2b: side-collections ride the same flag.
  bindLunoraTagColors(store.tagColors, {
    upsert: (tag, color) =>
      trackLunoraMutation(
        store.mutators.upsertTagColor({ userId, tag, color }),
      ),
    remove: (tag) =>
      trackLunoraMutation(store.mutators.deleteTagColor({ userId, tag })),
  });
  bindLunoraSavedQueries(store.savedQueries, {
    upsert: (row) =>
      trackLunoraMutation(
        store.mutators.upsertSavedQuery({
          userId,
          id: row.id,
          name: row.name,
          query: row.query,
          createdAt: row.createdAt,
        }),
      ),
    patchName: (id, name) =>
      trackLunoraMutation(store.mutators.patchSavedQuery({ userId, id, name })),
    remove: (id) =>
      trackLunoraMutation(store.mutators.deleteSavedQueryRow({ userId, id })),
  });
  bindLunoraDailyIndex(store.dailyIndex, {
    upsert: (key, nodeId) =>
      trackLunoraMutation(
        store.mutators.upsertDailyMapping({
          userId,
          key,
          nodeId,
          touchedAt: Date.now(),
        }),
      ),
    claimTx: (key, nodeId) =>
      store.mutators.claimDailyMapping({
        userId,
        key,
        nodeId,
        touchedAt: Date.now(),
      }),
  });
  bindLunoraAgentRuns(store.agentRuns);

  installMigrateConsoleHelper(() => ctx);

  collectionSub = store.collection.subscribeChanges(
    () => {
      feedTreeFromCollection(store);
    },
    { includeInitialState: true },
  );

  void store.collection
    .toArrayWhenReady()
    .then(async () => {
      if (!ctx || ctx.store !== store) return;
      feedTreeFromCollection(store);
      // Classic DO → Lunora migrate / KV heal (ADR 0058 watermarks). Shell stays
      // gated until migrate settles — otherwise the user can edit/seed into an
      // empty shard while import chunks land.
      const next = await maybeAutoMigrateToLunora(store, userId);
      if (!ctx || ctx.store !== store) return;
      feedTreeFromCollection(store);
      markNodesSyncReady();
      if (next === "seed") maybeSeed(store, userId);
    })
    .catch((err) => {
      console.error("[lunora-sync] wholeOutline load failed", err);
      // Surface the shell anyway — empty outline + save toast on writes.
      markNodesSyncReady();
      notifySaveFailed(err);
    });
}

function maybeSeed(store: OutlineStore, userId: string): void {
  if (seedStarted) return;
  const nodeCount = store.collection.toArray.length;
  if (!shouldSeedOutline({ isReady: true, nodeCount })) return;
  seedStarted = true;
  void seedEmptyOutline({
    userId,
    seedIfEmpty: (args) => {
      const tx = store.mutators.seedIfEmpty(args);
      return tx.isPersisted.promise.then(() => undefined);
    },
  }).catch((err) => {
    seedStarted = false;
    console.error("[lunora-sync] seedIfEmpty failed", err);
    notifySaveFailed(err);
  });
}

/** Tear down Lunora sync (account switch / flag OFF). */
export function stopLunoraOutlineSync(): void {
  collectionSub?.unsubscribe();
  collectionSub = null;
  unbindLunoraTagColors();
  unbindLunoraSavedQueries();
  unbindLunoraDailyIndex();
  unbindLunoraAgentRuns();
  ctx = null;
  seedStarted = false;
}

/**
 * Force an in-app shape reload (same data path as a hard refresh).
 *
 * Server-originated writes (`fireAgentRun` → `commitAgentAnswer`) only reach
 * live clients via `/_lunora/ws` shape poke. When the socket is dead/403, the
 * action still commits durably but the outline store stays stale until reload.
 * Call this after a completed agent fire so answer children appear without F5.
 *
 * Preserves `window.scrollY` (window virtualizer) and optionally marks
 * `answerRootId` for a fade/slide entrance — never scrollIntoView / focus.
 */
export function softReloadLunoraOutline(opts?: {
  answerRootId?: string | null;
}): void {
  if (!ctx) return;
  const userId = ctx.userId;
  const scrollY =
    typeof window !== "undefined"
      ? window.scrollY || document.documentElement.scrollTop || 0
      : 0;
  if (opts?.answerRootId) noteAgentAnswerArrive(opts.answerRootId);
  // #region agent log
  const beforeKids = ctx.store.collection.toArray.length;
  fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a23e41",
    },
    body: JSON.stringify({
      sessionId: "a23e41",
      hypothesisId: "H2",
      location: "src/data/lunora-sync.ts:softReloadLunoraOutline",
      message: "soft-reloading Lunora outline after agent commit",
      data: {
        userIdLen: userId.length,
        nodeCountBefore: beforeKids,
        scrollY,
        answerRootId: opts?.answerRootId ?? null,
      },
      timestamp: Date.now(),
      runId: "ui-sync",
    }),
  }).catch(() => {});
  // #endregion
  stopLunoraOutlineSync();
  startLunoraOutlineSync(userId);
  // Tree feed is async (toArrayWhenReady); restore scroll after layout settles.
  if (typeof window !== "undefined") {
    const restore = () => {
      window.scrollTo(0, scrollY);
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(restore);
      // One more pass after collection→tree feed (usually <100ms).
      window.setTimeout(restore, 50);
      window.setTimeout(restore, 200);
    });
  }
}

/** Fire-and-forget helper: await watermark hold, toast on failure. */
export function trackLunoraMutation(tx: {
  isPersisted: { promise: Promise<unknown> };
}): void {
  tx.isPersisted.promise.catch(notifySaveFailed);
}

// HMR: `startLunoraOutlineSync` is idempotent per userId, so a store-module
// edit would otherwise keep the old mutator bindings (and a hung isPersisted
// waiter) alive across Fast Refresh. Tear down + restart with the new store.
if (import.meta.hot) {
  import.meta.hot.accept("./lunora-outline-store", () => {
    const userId = ctx?.userId;
    stopLunoraOutlineSync();
    if (userId) startLunoraOutlineSync(userId);
  });
}
