import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Data, Effect, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { hasWindow } from "../env";
import { subscribeCalendarSync } from "./calendar-sync";
import { resyncNodes, waitForSeqStrictE } from "./collection";
import { DEFAULT_WEEK_START, type WeekStart } from "./date-links";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

const KEYS = {
  bible: "editor-feature:bible",
  daily: "editor-feature:daily",
  weekStart: "daily:week-start",
} as const;
export type EditorFeature = "bible" | "daily";

const featureRowSchema = Schema.Struct({
  key: Schema.Literals([KEYS.bible, KEYS.daily]),
  enabled: Schema.Boolean,
});
const weekStartRowSchema = Schema.Struct({
  key: Schema.Literal(KEYS.weekStart),
  weekStart: Schema.Literals(["sunday", "monday"]),
});
const rowSchema = Schema.Union([featureRowSchema, weekStartRowSchema]);
type PreferenceRow = Schema.Schema.Type<typeof rowSchema>;
const isPreferenceKey = Schema.is(
  Schema.Struct({
    key: Schema.Literals([KEYS.bible, KEYS.daily, KEYS.weekStart]),
  }),
);

const collection = createCollection(
  queryCollectionOptions({
    id: "editor-features",
    queryKey: ["kv", "account-prefs", "editor-features"],
    queryClient,
    queryFn: async () => {
      // account-prefs also contains internal retirement records. Decode only
      // our namespaced rows; never overwrite or expose unrelated preferences.
      const values = await kvFetch<unknown>("account-prefs");
      const decoded = await Effect.runPromise(
        Schema.decodeUnknownEffect(Schema.Array(rowSchema))(
          values.filter(isPreferenceKey),
        ),
      );
      return [...decoded];
    },
    getKey: (row: PreferenceRow) => row.key,
    schema: Schema.toStandardSchemaV1(rowSchema),
    onInsert: async ({ transaction }) => {
      await kvPut("account-prefs", toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut("account-prefs", toKvRows(transaction));
      return { refetch: false };
    },
  }),
);

interface FeatureSnapshot {
  bible: boolean;
  daily: boolean;
  weekStart: WeekStart;
  ready: boolean;
  error: boolean;
}
const INITIAL: FeatureSnapshot = {
  bible: true,
  daily: true,
  weekStart: DEFAULT_WEEK_START,
  ready: false,
  error: false,
};
let snapshot = INITIAL;
let syncedWeekStart: WeekStart | null = null;
let started = false;
const listeners = new Set<() => void>();

function rebuild(ready = snapshot.ready, error = snapshot.error) {
  const rows = collection.toArray;
  const bibleRow = rows.find((r) => r.key === KEYS.bible);
  const dailyRow = rows.find((r) => r.key === KEYS.daily);
  const weekStartRow = rows.find((r) => r.key === KEYS.weekStart);
  const bible = bibleRow?.key === KEYS.bible ? bibleRow.enabled : true;
  const daily = dailyRow?.key === KEYS.daily ? dailyRow.enabled : true;
  const weekStart =
    syncedWeekStart ??
    (weekStartRow?.key === KEYS.weekStart
      ? weekStartRow.weekStart
      : DEFAULT_WEEK_START);
  if (
    snapshot.bible === bible &&
    snapshot.daily === daily &&
    snapshot.weekStart === weekStart &&
    snapshot.ready === ready &&
    snapshot.error === error
  )
    return;
  snapshot = { bible, daily, weekStart, ready, error };
  for (const listener of listeners) listener();
}

function ensureStarted() {
  if (started || !hasWindow()) return;
  started = true;
  collection.subscribeChanges(() => rebuild(), { includeInitialState: true });
  // Empty collections emit no row change; readiness is a separate contract.
  void collection.toArrayWhenReady().then(
    () => rebuild(true, false),
    () => rebuild(false, true),
  );
  // QueryClient has no mounted React provider in this SPA. Refresh this account
  // collection explicitly on tab focus, retaining the last good values if offline.
  const refresh = () => {
    void collection.utils.refetch({ throwOnError: true }).then(
      () => rebuild(true, false),
      () => rebuild(snapshot.ready, true),
    );
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  subscribeCalendarSync((calendar) => {
    syncedWeekStart = calendar.weekStart;
    rebuild(true, false);
    void collection.utils.refetch({ throwOnError: true }).then(
      () => {
        if (syncedWeekStart === calendar.weekStart) syncedWeekStart = null;
        rebuild(true, false);
      },
      () => rebuild(snapshot.ready, true),
    );
  });
}

export function subscribeEditorFeatures(listener: () => void): () => void {
  // Registration is inert: the registry subscribes at module load, before auth.
  // Fetching starts only through a signed-in hook or loadEditorFeatures().
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEditorFeatures(): FeatureSnapshot {
  ensureStarted();
  return snapshot;
}

export function useEditorFeatures(): FeatureSnapshot {
  return useSyncExternalStore(
    subscribeEditorFeatures,
    getEditorFeatures,
    () => INITIAL,
  );
}

export async function loadEditorFeatures(): Promise<void> {
  ensureStarted();
  await collection.toArrayWhenReady();
  rebuild(true, false);
}

export async function retryEditorFeatures(): Promise<void> {
  await collection.utils.refetch({ throwOnError: true });
  rebuild(true, false);
}

export async function setEditorFeature(
  feature: EditorFeature,
  enabled: boolean,
): Promise<void> {
  await loadEditorFeatures();
  const key = KEYS[feature];
  const transaction = collection.has(key)
    ? collection.update(key, (draft) => {
        if ("enabled" in draft) draft.enabled = enabled;
      })
    : collection.insert({ key, enabled });
  await transaction.isPersisted.promise;
}

export class WeekStartMigrationError extends Data.TaggedError(
  "WeekStartMigrationError",
)<{ cause: unknown }> {
  get message() {
    return "week-start migration failed";
  }
}

const weekStartResponseSchema = Schema.Struct({
  weekStart: Schema.Literals(["sunday", "monday"]),
  seq: Schema.Number,
});

type WeekStartRequest =
  | { operation: "canonicalize" }
  | { operation: "set"; weekStart: WeekStart };

async function requestWeekStartMigration(
  request: WeekStartRequest,
): Promise<WeekStart> {
  const result = await Effect.runPromise(
    Effect.tryPromise({
      try: (signal) =>
        fetch("/api/daily/week-start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal,
        }),
      catch: (cause) => new WeekStartMigrationError({ cause }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) => new WeekStartMigrationError({ cause }),
            })
          : Effect.fail(
              new WeekStartMigrationError({
                cause: new Error(`HTTP ${response.status}`),
              }),
            ),
      ),
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(weekStartResponseSchema)(body).pipe(
          Effect.mapError((cause) => new WeekStartMigrationError({ cause })),
        ),
      ),
    ),
  );
  try {
    await Effect.runPromise(waitForSeqStrictE(result.seq));
  } catch (cause) {
    resyncNodes();
    throw new WeekStartMigrationError({ cause });
  }
  await collection.utils.refetch({ throwOnError: true });
  rebuild(true, false);
  return result.weekStart;
}

let canonicalWeekStart: WeekStart | null = null;
let canonicalizing: Promise<void> | null = null;

/** Ensure legacy ISO week keys have passed through the authoritative migration
 *  even when the effective default remains Monday. One request per preference
 *  value per session; a failed request remains retryable. */
export async function ensureWeekStartCanonical(): Promise<void> {
  await loadEditorFeatures();
  if (canonicalWeekStart === snapshot.weekStart) return;
  if (canonicalizing) return canonicalizing;
  canonicalizing = requestWeekStartMigration({ operation: "canonicalize" })
    .then((weekStart) => {
      canonicalWeekStart = weekStart;
    })
    .finally(() => {
      canonicalizing = null;
    });
  return canonicalizing;
}

/** Change calendar meaning only after the Durable Object atomically migrates the
 *  Daily scaffold and preference. No optimistic local flip: failure preserves
 *  the old account model. */
export async function setWeekStart(weekStart: WeekStart): Promise<void> {
  await loadEditorFeatures();
  if (snapshot.weekStart === weekStart) {
    await ensureWeekStartCanonical();
    return;
  }
  await requestWeekStartMigration({ operation: "set", weekStart });
  canonicalWeekStart = weekStart;
}
