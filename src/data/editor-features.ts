import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Data, Effect, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { hasWindow } from "../env";
import { subscribeCalendarSync } from "./calendar-sync";
import { resyncNodes, waitForSeqStrictE } from "./collection";
import { DEFAULT_WEEK_START, type WeekStart } from "./date-links";
import {
  DEFAULT_FOCUS_SETTINGS,
  focusSettingsSchema,
  type FocusSettings,
} from "./focus-settings";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

const KEYS = {
  bible: "editor-feature:bible",
  daily: "editor-feature:daily",
  embeds: "editor-feature:embeds",
  externalEmbeds: "external-embeds",
  weekStart: "daily:week-start",
  dayStream: "daily:day-stream",
  weekStrip: "daily:week-strip",
  emptyDays: "daily:empty-days",
  focus: "focus:settings",
} as const;
export type EditorFeature = "bible" | "daily" | "embeds";
/** A Daily notes option that is a plain on/off switch (ADR 0070). */
export type DailyToggle = "dayStream" | "weekStrip";
export const EMPTY_DAYS_MODES = ["show", "fold", "skip"] as const;
/** How the Day stream presents Empty days (ADR 0070). */
export type EmptyDaysMode = (typeof EMPTY_DAYS_MODES)[number];

const featureRowSchema = Schema.Struct({
  key: Schema.Literals([
    KEYS.bible,
    KEYS.daily,
    KEYS.embeds,
    KEYS.externalEmbeds,
  ]),
  enabled: Schema.Boolean,
});
const weekStartRowSchema = Schema.Struct({
  key: Schema.Literal(KEYS.weekStart),
  weekStart: Schema.Literals(["sunday", "monday"]),
});
const dailyToggleRowSchema = Schema.Struct({
  key: Schema.Literals([KEYS.dayStream, KEYS.weekStrip]),
  enabled: Schema.Boolean,
});
const emptyDaysRowSchema = Schema.Struct({
  key: Schema.Literal(KEYS.emptyDays),
  emptyDays: Schema.Literals(EMPTY_DAYS_MODES),
});
const rowSchema = Schema.Union([
  featureRowSchema,
  weekStartRowSchema,
  dailyToggleRowSchema,
  emptyDaysRowSchema,
  Schema.Struct({
    key: Schema.Literal(KEYS.focus),
    settings: focusSettingsSchema,
  }),
]);
type PreferenceRow = Schema.Schema.Type<typeof rowSchema>;
const isPreferenceKey = Schema.is(
  Schema.Struct({
    key: Schema.Literals([
      KEYS.bible,
      KEYS.daily,
      KEYS.embeds,
      KEYS.externalEmbeds,
      KEYS.weekStart,
      KEYS.dayStream,
      KEYS.weekStrip,
      KEYS.emptyDays,
      KEYS.focus,
    ]),
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
  embeds: boolean;
  externalEmbeds: boolean;
  externalEmbedsSaving: boolean;
  weekStart: WeekStart;
  weekStartSaving: boolean;
  dayStream: boolean;
  weekStrip: boolean;
  emptyDays: EmptyDaysMode;
  focus: FocusSettings;
  ready: boolean;
  error: boolean;
}
const INITIAL: FeatureSnapshot = {
  bible: true,
  daily: true,
  embeds: true,
  externalEmbeds: false,
  externalEmbedsSaving: false,
  weekStart: DEFAULT_WEEK_START,
  weekStartSaving: false,
  dayStream: true,
  weekStrip: true,
  emptyDays: "show",
  focus: DEFAULT_FOCUS_SETTINGS,
  ready: false,
  error: false,
};
let snapshot = INITIAL;
let syncedWeekStart: WeekStart | null = null;
let started = false;
let weekStartSaving = false;
let externalEmbedsPendingSaves = 0;
let externalEmbedsMaskedOff = false;
let externalEmbedsSaveTail = Promise.resolve();
let externalEmbedsIntent = 0;
const listeners = new Set<() => void>();

function rebuild(ready = snapshot.ready, error = snapshot.error) {
  const rows = collection.toArray;
  const bibleRow = rows.find((r) => r.key === KEYS.bible);
  const dailyRow = rows.find((r) => r.key === KEYS.daily);
  const embedsRow = rows.find((r) => r.key === KEYS.embeds);
  const externalEmbedsRow = rows.find((r) => r.key === KEYS.externalEmbeds);
  const weekStartRow = rows.find((r) => r.key === KEYS.weekStart);
  const dayStreamRow = rows.find((r) => r.key === KEYS.dayStream);
  const weekStripRow = rows.find((r) => r.key === KEYS.weekStrip);
  const emptyDaysRow = rows.find((r) => r.key === KEYS.emptyDays);
  const focusRow = rows.find((r) => r.key === KEYS.focus);
  const focus =
    focusRow?.key === KEYS.focus ? focusRow.settings : DEFAULT_FOCUS_SETTINGS;
  // Missing rows mean the defaults (ADR 0070).
  const dayStream =
    dayStreamRow && "enabled" in dayStreamRow ? dayStreamRow.enabled : true;
  const weekStrip =
    weekStripRow && "enabled" in weekStripRow ? weekStripRow.enabled : true;
  const emptyDays =
    emptyDaysRow && "emptyDays" in emptyDaysRow
      ? emptyDaysRow.emptyDays
      : "show";
  const bible = bibleRow?.key === KEYS.bible ? bibleRow.enabled : true;
  const daily = dailyRow?.key === KEYS.daily ? dailyRow.enabled : true;
  const embeds = embedsRow?.key === KEYS.embeds ? embedsRow.enabled : true;
  // External loading fails closed. A local revoke masks even stale/refetched
  // server truth, and readiness alone never implies consent.
  const externalEmbeds =
    ready &&
    !externalEmbedsMaskedOff &&
    externalEmbedsRow?.key === KEYS.externalEmbeds &&
    externalEmbedsRow.enabled;
  const externalEmbedsSaving = externalEmbedsPendingSaves > 0;
  const weekStart =
    syncedWeekStart ??
    (weekStartRow?.key === KEYS.weekStart
      ? weekStartRow.weekStart
      : DEFAULT_WEEK_START);
  if (
    snapshot.bible === bible &&
    snapshot.daily === daily &&
    snapshot.embeds === embeds &&
    snapshot.externalEmbeds === externalEmbeds &&
    snapshot.externalEmbedsSaving === externalEmbedsSaving &&
    snapshot.weekStart === weekStart &&
    snapshot.weekStartSaving === weekStartSaving &&
    snapshot.dayStream === dayStream &&
    snapshot.weekStrip === weekStrip &&
    snapshot.emptyDays === emptyDays &&
    snapshot.focus === focus &&
    snapshot.ready === ready &&
    snapshot.error === error
  )
    return;
  snapshot = {
    bible,
    daily,
    embeds,
    externalEmbeds,
    externalEmbedsSaving,
    weekStart,
    weekStartSaving,
    dayStream,
    weekStrip,
    emptyDays,
    focus,
    ready,
    error,
  };
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
    rebuild(snapshot.ready, snapshot.error);
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

/** Read-only snapshot for plugin registrations, which run before auth. */
export function peekEditorFeatures(): FeatureSnapshot {
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

/** Persist one Daily notes on/off option (ADR 0070). Optimistic, like
 *  {@link setEditorFeature}: the collection rolls back on a failed save. */
export async function setDailyToggle(
  option: DailyToggle,
  enabled: boolean,
): Promise<void> {
  await loadEditorFeatures();
  const key = KEYS[option];
  const transaction = collection.has(key)
    ? collection.update(key, (draft) => {
        if ("enabled" in draft) draft.enabled = enabled;
      })
    : collection.insert({ key, enabled });
  await transaction.isPersisted.promise;
}

/** Persist how the Day stream presents Empty days (ADR 0070). */
export async function setEmptyDaysMode(mode: EmptyDaysMode): Promise<void> {
  await loadEditorFeatures();
  const key = KEYS.emptyDays;
  const transaction = collection.has(key)
    ? collection.update(key, (draft) => {
        if ("emptyDays" in draft) draft.emptyDays = mode;
      })
    : collection.insert({ key, emptyDays: mode });
  await transaction.isPersisted.promise;
}

export async function setFocusSettings(settings: FocusSettings): Promise<void> {
  await loadEditorFeatures();
  const key = KEYS.focus;
  const transaction = collection.has(key)
    ? collection.update(key, (draft) => {
        if ("settings" in draft) draft.settings = settings;
      })
    : collection.insert({ key, settings });
  await transaction.isPersisted.promise;
}

/** Persist account-wide permission to contact supported embed providers.
 * Enabling is pessimistic; revocation is locally effective before its write. */
export function setExternalEmbeds(enabled: boolean): Promise<void> {
  const intent = ++externalEmbedsIntent;
  externalEmbedsPendingSaves += 1;
  // Revoke immediately; approval (including after a failed revoke) waits for persistence.
  externalEmbedsMaskedOff = true;
  rebuild();

  const save = externalEmbedsSaveTail.then(async () => {
    try {
      await loadEditorFeatures();
      await kvPut("account-prefs", [
        {
          key: KEYS.externalEmbeds,
          value: { key: KEYS.externalEmbeds, enabled },
        },
      ]);
      await collection.utils.refetch({ throwOnError: true });
      if (intent === externalEmbedsIntent) externalEmbedsMaskedOff = !enabled;
      rebuild(true, false);
    } catch (cause) {
      if (intent === externalEmbedsIntent) externalEmbedsMaskedOff = true;
      rebuild(snapshot.ready, true);
      throw cause;
    } finally {
      externalEmbedsPendingSaves -= 1;
      rebuild();
    }
  });
  externalEmbedsSaveTail = save.catch(() => undefined);
  return save;
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
  weekStartSaving = true;
  rebuild();
  try {
    if (snapshot.weekStart === weekStart) {
      await ensureWeekStartCanonical();
      return;
    }
    await requestWeekStartMigration({ operation: "set", weekStart });
    canonicalWeekStart = weekStart;
  } finally {
    weekStartSaving = false;
    rebuild();
  }
}
