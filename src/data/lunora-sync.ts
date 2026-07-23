/**
 * Lunora outline sync lifecycle for the ADR 0055 flag-swap (default OFF).
 *
 * When `isLunoraSyncEnabled()`:
 * - creates `@lunora/db` `wholeOutline` collection + bound mutators
 * - feeds ADR 0004 `tree-store` from collection rows
 * - marks sync ready (shell spinner) + `seedIfEmpty` when the outline is empty
 *
 * SPA/no-SSR: never start during prerender. Custom `/api/sync` stays cold
 * (see `collection.ts` early-return when the flag is ON).
 */

import { markNodesSyncReady } from "./collection";
import { isLunoraSyncEnabled } from "./flags";
import { outlineNodeToNode, rowsToOutlineNodes } from "./lunora-bridge";
import { getLunoraClient } from "./lunora-client";
import { createOutlineStore, type OutlineStore } from "./lunora-outline-store";
import { shouldSeedOutline, seedEmptyOutline } from "./outline-plans";
import { notifySaveFailed } from "./save-failure";
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

  collectionSub = store.collection.subscribeChanges(
    () => {
      feedTreeFromCollection(store);
    },
    { includeInitialState: true },
  );

  void store.collection
    .toArrayWhenReady()
    .then(() => {
      if (!ctx || ctx.store !== store) return;
      feedTreeFromCollection(store);
      markNodesSyncReady();
      maybeSeed(store, userId);
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
  ctx = null;
  seedStarted = false;
}

/** Fire-and-forget helper: await watermark hold, toast on failure. */
export function trackLunoraMutation(tx: {
  isPersisted: { promise: Promise<unknown> };
}): void {
  tx.isPersisted.promise.catch(notifySaveFailed);
}
