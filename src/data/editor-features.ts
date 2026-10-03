import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Effect, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { hasWindow } from "../env";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

const KEYS = {
  bible: "editor-feature:bible",
  daily: "editor-feature:daily",
} as const;
export type EditorFeature = keyof typeof KEYS;

const rowSchema = Schema.Struct({
  key: Schema.Literals([KEYS.bible, KEYS.daily]),
  enabled: Schema.Boolean,
});
interface FeatureRow extends Schema.Schema.Type<typeof rowSchema> {}
const isFeatureKey = Schema.is(Schema.Struct({ key: rowSchema.fields.key }));

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
          values.filter(isFeatureKey),
        ),
      );
      return [...decoded];
    },
    getKey: (row: FeatureRow) => row.key,
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
  ready: boolean;
  error: boolean;
}
const INITIAL: FeatureSnapshot = {
  bible: true,
  daily: true,
  ready: false,
  error: false,
};
let snapshot = INITIAL;
let started = false;
const listeners = new Set<() => void>();

function rebuild(ready = snapshot.ready, error = snapshot.error) {
  const rows = collection.toArray;
  const bible = rows.find((r) => r.key === KEYS.bible)?.enabled ?? true;
  const daily = rows.find((r) => r.key === KEYS.daily)?.enabled ?? true;
  if (
    snapshot.bible === bible &&
    snapshot.daily === daily &&
    snapshot.ready === ready &&
    snapshot.error === error
  )
    return;
  snapshot = { bible, daily, ready, error };
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
        draft.enabled = enabled;
      })
    : collection.insert({ key, enabled });
  await transaction.isPersisted.promise;
}
