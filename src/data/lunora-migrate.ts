/**
 * One-shot UserOutlineDO → Lunora shard migrate (ADR 0055).
 *
 * Safe default: if Lunora already has nodes, skip (do not replace).
 * Classic DO data is left untouched.
 *
 * Auto-runs from `lunora-sync` when flag ON + Lunora empty + classic has data.
 * Manual: `await window.__dotflowyMigrateToLunora()` or More menu.
 */

import type { OutlineStore } from "./lunora-outline-store";
import type { OutlineNode } from "./outline-plans";

import { notifySaveFailed } from "./save-failure";

export type MigrateResult =
  | { status: "migrated"; nodes: number; kv: number }
  | { status: "skipped-nonempty"; nodes: number }
  | { status: "skipped-empty-source" }
  | { status: "failed"; error: unknown };

type ClassicNode = {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
};

type KvRow = { key: string; value: unknown };

const IMPORT_CHUNK = 500;

function asOutlineNode(n: ClassicNode, userId: string): OutlineNode {
  return {
    id: n.id,
    parentId: n.parentId,
    prevSiblingId: n.prevSiblingId,
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    collapsed: n.collapsed,
    bookmarkedAt: n.bookmarkedAt,
    mirrorOf: n.mirrorOf,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    origin: n.origin,
    kind: n.kind === "paragraph" ? "paragraph" : null,
    userId,
  };
}

async function fetchClassicNodes(): Promise<ClassicNode[]> {
  const res = await fetch("/api/nodes", { credentials: "include" });
  if (!res.ok) throw new Error(`GET /api/nodes ${res.status}`);
  const body = (await res.json()) as ClassicNode[];
  return Array.isArray(body) ? body : [];
}

async function fetchKv(collection: string): Promise<KvRow[]> {
  const res = await fetch(
    `/api/kv?collection=${encodeURIComponent(collection)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`GET /api/kv ${collection} ${res.status}`);
  const body = (await res.json()) as unknown[];
  if (!Array.isArray(body)) return [];
  // /api/kv GET returns the stored values; daily-index/tag-colors/saved-queries
  // each embed their key inside the value object.
  return body.map((value) => {
    const v = value as Record<string, unknown>;
    const key =
      typeof v.key === "string"
        ? v.key
        : typeof v.tag === "string"
          ? v.tag
          : typeof v.id === "string"
            ? v.id
            : String(v.key ?? "");
    return { key, value };
  });
}

async function importNodeChunks(
  store: OutlineStore,
  userId: string,
  nodes: OutlineNode[],
): Promise<void> {
  for (let i = 0; i < nodes.length; i += IMPORT_CHUNK) {
    const chunk = nodes.slice(i, i + IMPORT_CHUNK);
    const tx = store.mutators.importNodes({ userId, nodes: chunk });
    await tx.isPersisted.promise;
  }
}

async function importKv(store: OutlineStore, userId: string): Promise<number> {
  let count = 0;
  const t = Date.now();

  const tags = await fetchKv("tag-colors").catch(() => [] as KvRow[]);
  for (const row of tags) {
    const v = row.value as { tag?: string; color?: string };
    const tag = String(v.tag ?? row.key);
    const color = String(v.color ?? "");
    if (!tag || !color) continue;
    const tx = store.mutators.upsertTagColor({ userId, tag, color });
    await tx.isPersisted.promise;
    count += 1;
  }

  const saved = await fetchKv("saved-queries").catch(() => [] as KvRow[]);
  for (const row of saved) {
    const v = row.value as {
      id?: string;
      name?: string;
      query?: string;
      createdAt?: number;
    };
    const id = String(v.id ?? row.key);
    if (!id) continue;
    const tx = store.mutators.upsertSavedQuery({
      userId,
      id,
      name: String(v.name ?? v.query ?? id),
      query: String(v.query ?? ""),
      createdAt: Number(v.createdAt ?? t),
    });
    await tx.isPersisted.promise;
    count += 1;
  }

  const daily = await fetchKv("daily-index").catch(() => [] as KvRow[]);
  for (const row of daily) {
    const v = row.value as { key?: string; nodeId?: string };
    const key = String(v.key ?? row.key);
    const nodeId = String(v.nodeId ?? "");
    if (!key || !nodeId) continue;
    const tx = store.mutators.upsertDailyMapping({
      userId,
      key,
      nodeId,
      touchedAt: t,
    });
    await tx.isPersisted.promise;
    count += 1;
  }

  return count;
}

/**
 * Import classic DO outline (+ kv) into an empty Lunora shard.
 * @param force — unused for replace (replace is out of scope); reserved.
 */
export async function migrateClassicToLunora(
  store: OutlineStore,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<MigrateResult> {
  void opts.force;
  const lunoraCount = store.collection.toArray.length;
  if (lunoraCount > 0) {
    return { status: "skipped-nonempty", nodes: lunoraCount };
  }

  try {
    const classic = await fetchClassicNodes();
    if (classic.length === 0) {
      return { status: "skipped-empty-source" };
    }
    const nodes = classic.map((n) => asOutlineNode(n, userId));
    await importNodeChunks(store, userId, nodes);
    const kv = await importKv(store, userId);
    return { status: "migrated", nodes: nodes.length, kv };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Auto path: migrate when Lunora empty; returns whether seedIfEmpty should run. */
export async function maybeAutoMigrateToLunora(
  store: OutlineStore,
  userId: string,
): Promise<"seed" | "ready"> {
  const result = await migrateClassicToLunora(store, userId);
  switch (result.status) {
    case "migrated":
      console.info(
        `[lunora-migrate] imported ${result.nodes} nodes + ${result.kv} kv rows from classic DO`,
      );
      return "ready";
    case "skipped-nonempty":
      return "ready";
    case "skipped-empty-source":
      return "seed";
    case "failed":
      console.warn("[lunora-migrate] failed", result.error);
      notifySaveFailed(result.error);
      // Don't seed demo bullets over a failed migrate of real data — leave empty
      // so the operator can retry via __dotflowyMigrateToLunora.
      return "ready";
  }
}

/** DevTools / More-menu entry. */
export function installMigrateConsoleHelper(
  getStore: () => { store: OutlineStore; userId: string } | null,
): void {
  if (typeof window === "undefined") return;
  (
    window as unknown as {
      __dotflowyMigrateToLunora?: () => Promise<MigrateResult>;
    }
  ).__dotflowyMigrateToLunora = async () => {
    const ctx = getStore();
    if (!ctx) {
      return {
        status: "failed",
        error: new Error("Lunora sync not started (flag off?)"),
      };
    }
    return migrateClassicToLunora(ctx.store, ctx.userId);
  };
}
