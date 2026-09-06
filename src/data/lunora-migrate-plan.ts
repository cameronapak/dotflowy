/**
 * Pure migrate planner (ADR 0058) — classic DO → Lunora heal decisions.
 * Unit-tested without a live store / network.
 */

export type MigrateStateSnapshot = {
  nodesAt: number | null;
  kvAt: number | null;
};

/** What the migrate runner should do next. */
export type MigrateStep =
  | "full"
  | "kv-only"
  | "mark-kv-complete"
  | "noop"
  | "empty-source";

export type PlanMigrateStepsInput = {
  lunoraNodeCount: number;
  migrateState: MigrateStateSnapshot | null;
  classicHasNodes: boolean;
  classicKvCount: number;
  lunoraKvCount: number;
};

/**
 * Decide migrate work from counts + watermarks.
 *
 * - `nodesAt` means the entire classic node snapshot is imported — never
 *   infer it from `lunoraNodeCount > 0` (a partial chunk import can leave
 *   some rows durable while classic still has missing ids).
 * - KV completion stays independent of nodes (Daily = `daily-index` KV).
 */
export function planMigrateSteps(input: PlanMigrateStepsInput): MigrateStep {
  const nodesAt = input.migrateState?.nodesAt ?? null;
  const kvAt = input.migrateState?.kvAt ?? null;

  if (nodesAt != null && kvAt != null) return "noop";

  // Node watermark missing + classic still has the source → finish node
  // import even when Lunora already has some rows (idempotent missing-id
  // import in the runner). Never treat lunoraNodeCount > 0 as complete.
  if (nodesAt == null && input.classicHasNodes) return "full";

  // Node half done (watermark set, or nothing classic to import).
  if (kvAt == null) {
    if (input.classicKvCount > 0) return "kv-only";
    // classicKvCount === 0 means a successful empty classic read (failed GETs
    // must reject before reaching the planner). Stamp kvAt when Lunora already
    // has rows / nodesAt is set, or when both sides are empty after a real
    // outline landed — otherwise we'd retry forever.
    if (
      input.lunoraKvCount > 0 ||
      input.lunoraNodeCount > 0 ||
      nodesAt != null
    ) {
      return "mark-kv-complete";
    }
    return "empty-source";
  }

  // kvAt set, nodesAt null, !classicHasNodes — stamp nodesAt only.
  return "mark-kv-complete";
}

export type ClassicKvRow = { key: string; value: unknown };

export type ImportKvRow =
  | { kind: "tagColor"; tag: string; color: string }
  | {
      kind: "savedQuery";
      id: string;
      name: string;
      query: string;
      createdAt: number;
    }
  | {
      kind: "dailyIndex";
      key: string;
      nodeId: string;
      touchedAt: number;
    };

/** Classic `/api/kv?collection=daily-index` value → Lunora `importKvRows` row. */
export function classicDailyRowToImport(
  row: ClassicKvRow,
  touchedAt: number,
): Extract<ImportKvRow, { kind: "dailyIndex" }> | null {
  // SAFETY: value is JSON persisted by the classic kv daily-index writer, whose shape is { key?, nodeId? }; String() and the emptiness check below absorb a stray shape.
  const value = row.value as { key?: string; nodeId?: string };
  const key = String(value.key ?? row.key);
  const nodeId = String(value.nodeId ?? "");
  if (!key || !nodeId) return null;
  return { kind: "dailyIndex", key, nodeId, touchedAt };
}

/** Classic tag-colors row → import shape. */
export function classicTagColorRowToImport(
  row: ClassicKvRow,
): Extract<ImportKvRow, { kind: "tagColor" }> | null {
  // SAFETY: value is JSON persisted by the classic kv tag-color writer (tag-colors.ts rowToKv), whose shape is { tag?, color? }; String() and the emptiness check below absorb a stray shape.
  const value = row.value as { tag?: string; color?: string };
  const tag = String(value.tag ?? row.key);
  const color = String(value.color ?? "");
  if (!tag || !color) return null;
  return { kind: "tagColor", tag, color };
}

/** Classic saved-queries row → import shape. */
export function classicSavedQueryRowToImport(
  row: ClassicKvRow,
  touchedAt: number,
): Extract<ImportKvRow, { kind: "savedQuery" }> | null {
  // SAFETY: value is JSON persisted by the classic kv saved-query writer, whose shape is { id?, name?, query?, createdAt? }; String() and the emptiness check below absorb a stray shape.
  const value = row.value as {
    id?: string;
    name?: string;
    query?: string;
    createdAt?: number;
  };
  const id = String(value.id ?? row.key);
  if (!id) return null;
  return {
    kind: "savedQuery",
    id,
    name: String(value.name ?? value.query ?? id),
    query: String(value.query ?? ""),
    createdAt: Number(value.createdAt ?? touchedAt),
  };
}

/** Build the full importKvRows payload from classic side-collection fetches. */
export function planClassicKvImportRows(input: {
  tagColors: ClassicKvRow[];
  savedQueries: ClassicKvRow[];
  dailyIndex: ClassicKvRow[];
  touchedAt: number;
}): ImportKvRow[] {
  const { touchedAt } = input;
  return [
    ...input.tagColors.flatMap((row) => {
      const mapped = classicTagColorRowToImport(row);
      return mapped ? [mapped] : [];
    }),
    ...input.savedQueries.flatMap((row) => {
      const mapped = classicSavedQueryRowToImport(row, touchedAt);
      return mapped ? [mapped] : [];
    }),
    ...input.dailyIndex.flatMap((row) => {
      const mapped = classicDailyRowToImport(row, touchedAt);
      return mapped ? [mapped] : [];
    }),
  ];
}
