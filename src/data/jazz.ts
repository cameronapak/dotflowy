import { useSyncExternalStore } from "react";
import { BrowserAuthSecretStore, createDb, type Db } from "jazz-tools";
import { app, type Node } from "./schema";

/**
 * Jazz client + the single source of truth for all outline nodes.
 *
 * Backed by Jazz 2.0 (jazz-tools): a local-first WASM SQLite-style runtime
 * persisted to OPFS, with last-write-wins-per-field sync built in. We mutate
 * directly (`getDb().insert / update / delete`) and Jazz handles persistence,
 * cross-tab coordination, and (once a server URL is configured) device sync.
 *
 * Why a module singleton instead of <JazzProvider> + useDb(): the entire data
 * layer (mutations, history, seed, tree-store) is non-React module code that
 * needs `db` synchronously. Creating the client once at module scope keeps that
 * code untouched; React only needs the ready signal (useDbReady) to gate the
 * first paint while the WASM runtime loads.
 *
 * Anonymous local-first identity (BrowserAuthSecretStore mints + persists a
 * per-device seed). The app id and sync server come from the `VITE_JAZZ_*` env
 * vars: with `VITE_JAZZ_SERVER_URL` set, the local doc syncs to that Jazz server;
 * unset, it stays local-only. The non-VITE `.env` secrets (admin/backend) are
 * server-only and are never referenced here. See PLAN.md (D2) and ADR 0016.
 *
 * SPA-only (ADR 0004): the runtime touches OPFS / Workers / localStorage, none
 * of which exist on the server, so bootstrap is guarded to the browser. During
 * the prerender pass the db never starts and tree-store reads stay empty.
 */

/** Registered Jazz app id, or a stable local fallback for local-only dev. */
const APP_ID = import.meta.env.VITE_JAZZ_APP_ID || "dotflowy-oss";
/** Sync server URL. Set => sync to it; unset/empty => local-only. */
const SERVER_URL = import.meta.env.VITE_JAZZ_SERVER_URL || undefined;
const LEGACY_STORAGE_KEY = "dotflowy-oss:nodes";
// Scoped to the app id: a different Jazz app is a different OPFS namespace, so
// the legacy localStorage doc should import afresh into it.
const MIGRATED_FLAG_KEY = `dotflowy-oss:jazz-migrated:${APP_ID}`;

let dbInstance: Db | null = null;
let readyPromise: Promise<Db> | null = null;
let dbReady = false;
const readyListeners = new Set<() => void>();

function markReady() {
  dbReady = true;
  for (const l of readyListeners) l();
}

/**
 * Begin (once) loading the Jazz runtime and the local document. Resolves to the
 * live `Db`. Browser-only; never resolves on the server. After this resolves the
 * legacy localStorage doc has been migrated and `getDb()` is safe to call.
 */
export function whenDbReady(): Promise<Db> {
  if (readyPromise) return readyPromise;
  if (typeof window === "undefined") {
    // No db on the server; hand back a promise that never resolves so callers
    // (the tree-store subscription) simply no-op during prerender.
    readyPromise = new Promise<Db>(() => {});
    return readyPromise;
  }
  readyPromise = (async () => {
    try {
      const secret = await BrowserAuthSecretStore.getOrCreateSecret();
      const db = await createDb({
        appId: APP_ID,
        serverUrl: SERVER_URL,
        driver: { type: "persistent" },
        secret,
      });
      dbInstance = db;
      // Dev-only escape hatch for resetting local state (OPFS outbox/tombstones):
      // `await window.__jazzDb.deleteClientStorage()`. Jazz tears down the worker,
      // deletes the OPFS files, and respawns cleanly — the only safe way to wipe
      // while the runtime holds OPFS handles.
      if (import.meta.env.DEV) {
        ;(window as unknown as { __jazzDb?: Db }).__jazzDb = db
      }
      migrateFromLocalStorage(db);
      // First-run seed, decided here (before any paint) so the editor never has
      // to distinguish "db still loading" from "genuinely empty". Dynamic import
      // breaks the seed.ts -> mutations.ts -> jazz.ts require cycle.
      const existing = await db.all(app.nodes.limit(1));
      if (existing.length === 0) {
        const { seedIfEmpty } = await import("./seed");
        seedIfEmpty(false);
      }
      markReady();
      return db;
    } catch (err) {
      // Surface a boot failure rather than hanging the loading gate forever.
      console.error("[jazz] bootstrap failed:", err);
      throw err;
    }
  })();
  return readyPromise;
}

/**
 * The live db. Throws if called before {@link whenDbReady} has resolved -- which
 * never happens in practice: user-triggered mutations only fire after the editor
 * has rendered real nodes, by which point the subscription (hence the db) is up.
 */
export function getDb(): Db {
  if (!dbInstance) {
    throw new Error("Jazz db not ready -- await whenDbReady() before mutating");
  }
  return dbInstance;
}

/** Split a full Node into Jazz's init shape (everything except the id). */
function toInit(node: Node) {
  return {
    parentId: node.parentId,
    prevSiblingId: node.prevSiblingId,
    text: node.text,
    isTask: node.isTask,
    completed: node.completed,
    collapsed: node.collapsed,
    bookmarkedAt: node.bookmarkedAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/** Insert a fully-formed Node, preserving its caller-chosen id. */
export function insertNode(node: Node): void {
  getDb().insert(app.nodes, toInit(node), { id: node.id });
}

/**
 * Re-create a node that may currently exist as a tombstone (used by undo, which
 * resurrects rows it had deleted). Jazz deletes are soft, so a plain insert of a
 * previously-deleted id would collide; `restore` revives the tombstone instead,
 * falling back to insert when the id was never persisted.
 */
export function restoreNode(node: Node): void {
  const db = getDb();
  try {
    db.restore(app.nodes, node.id, toInit(node));
  } catch {
    db.insert(app.nodes, toInit(node), { id: node.id });
  }
}

/**
 * One-time, idempotent import of the pre-Jazz localStorage document into Jazz.
 *
 * The old TanStack DB LocalStorage collection stored an object keyed by id where
 * each value is `{ data: Node, versionKey }` -- not a `Node[]`. We read it once,
 * insert every row (preserving ids + timestamps), backfill the two fields that
 * predate their migrations (isTask, bookmarkedAt), then set a flag so we never
 * run again. The legacy key is left in place as a safety net. See PLAN.md (D8).
 */
function migrateFromLocalStorage(db: Db): void {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(MIGRATED_FLAG_KEY)) return;

  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATED_FLAG_KEY, "1");
    return;
  }

  try {
    const store = JSON.parse(raw) as Record<string, { data?: Partial<Node> }>;
    for (const entry of Object.values(store)) {
      const d = entry?.data;
      if (!d || typeof d.id !== "string") continue;
      const node: Node = {
        id: d.id,
        parentId: d.parentId ?? null,
        prevSiblingId: d.prevSiblingId ?? null,
        text: d.text ?? "",
        isTask: d.isTask ?? false,
        completed: d.completed ?? false,
        collapsed: d.collapsed ?? false,
        bookmarkedAt: d.bookmarkedAt ?? null,
        createdAt: d.createdAt ?? Date.now(),
        updatedAt: d.updatedAt ?? Date.now(),
      };
      db.insert(app.nodes, toInit(node), { id: node.id });
    }
    localStorage.setItem(MIGRATED_FLAG_KEY, "1");
  } catch {
    // Corrupt legacy payload: leave the flag unset so a future load can retry,
    // and let the user start from a fresh seed rather than crashing boot.
  }
}

/** React subscription to the db-ready signal, for gating the first paint. */
export function useDbReady(): boolean {
  return useSyncExternalStore(
    (cb) => {
      readyListeners.add(cb);
      // Kick off loading the first time anything observes readiness.
      void whenDbReady();
      return () => readyListeners.delete(cb);
    },
    () => dbReady,
    () => false,
  );
}
