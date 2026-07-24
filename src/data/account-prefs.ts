/**
 * Account-scoped preferences synced via classic DO `/api/kv` (ADR 0055 opt-in).
 *
 * Lunora beta opt-in lives here — not localStorage alone — so enabling on one
 * device can converge others on next load. The runtime flag still mirrors to
 * `dotflowy:flag:lunora-sync` so `LunoraSyncHost` remounts cleanly after reload.
 */

import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import { hardReset } from "../lib/auth-client";
import { isLunoraSyncEnabled, LUNORA_SYNC_FLAG_KEY } from "./flags";
import { kvFetch, kvPut, toKvRows } from "./kv-api";
import { queryClient } from "./query-client";

const prefRowSchema = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
});

export type AccountPrefRow = Schema.Schema.Type<typeof prefRowSchema>;

const KV = "account-prefs";
export const LUNORA_BETA_ROW_ID = "lunora-beta";

const PREFS_RELOAD_GUARD = "dotflowy:lunora-pref-sync-reload";

export const accountPrefsCollection = createCollection(
  queryCollectionOptions({
    id: "account-prefs",
    queryKey: ["kv", KV],
    queryClient,
    queryFn: () => kvFetch<AccountPrefRow>(KV),
    getKey: (row: AccountPrefRow) => row.id,
    schema: Schema.toStandardSchemaV1(prefRowSchema),
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction));
      return { refetch: false };
    },
  }),
);

function lunoraBetaRow(): AccountPrefRow | null {
  return (
    accountPrefsCollection.toArray.find((r) => r.id === LUNORA_BETA_ROW_ID) ??
    null
  );
}

function mirrorLunoraFlag(enabled: boolean) {
  try {
    window.localStorage.setItem(LUNORA_SYNC_FLAG_KEY, enabled ? "on" : "off");
  } catch {
    // Private mode — reload still picks up URL-less default until next success.
  }
}

async function writeLunoraBeta(enabled: boolean): Promise<void> {
  const row: AccountPrefRow = { id: LUNORA_BETA_ROW_ID, enabled };
  await kvPut(KV, [{ key: LUNORA_BETA_ROW_ID, value: row }]);
}

/** Persist Lunora beta opt-in, mirror the runtime flag, and reload. */
export async function setLunoraBetaEnabled(enabled: boolean): Promise<void> {
  await writeLunoraBeta(enabled);
  mirrorLunoraFlag(enabled);
  hardReset(window.location.pathname + window.location.search);
}

// --- Reactive read -----------------------------------------------------------

const HIDDEN = { ready: false, enabled: false } as const;

type LunoraBetaSnapshot = { ready: boolean; enabled: boolean };

let snapshot: LunoraBetaSnapshot = HIDDEN;
let collectionReady = false;
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  const enabled = collectionReady ? (lunoraBetaRow()?.enabled ?? false) : false;
  if (snapshot.ready === collectionReady && snapshot.enabled === enabled)
    return;
  snapshot = { ready: collectionReady, enabled };
  for (const l of listeners) l();
}

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  accountPrefsCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  });
  void accountPrefsCollection
    .toArrayWhenReady()
    .then(() => {
      collectionReady = true;
      rebuild();
      maybeSyncLocalFlagFromAccount();
    })
    .catch(() => {});
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): LunoraBetaSnapshot {
  ensureStarted();
  return snapshot;
}

/** Synced Lunora beta preference. `enabled` is false until the kv row loads. */
export function useLunoraBetaPref(): LunoraBetaSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => HIDDEN);
}

/**
 * When account pref and localStorage disagree, mirror localStorage and reload
 * once so `LunoraSyncHost` picks the synced value (multi-device opt-in).
 */
function maybeSyncLocalFlagFromAccount() {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem(PREFS_RELOAD_GUARD)) return;
    const q = new URLSearchParams(window.location.search).get("lunora-sync");
    if (q === "on" || q === "off" || q === "0" || q === "1") return;

    const synced = lunoraBetaRow()?.enabled === true;
    const localOn = isLunoraSyncEnabled();
    if (synced === localOn) return;

    mirrorLunoraFlag(synced);
    sessionStorage.setItem(PREFS_RELOAD_GUARD, "1");
    hardReset(window.location.pathname + window.location.search);
  } catch {
    // sessionStorage / localStorage unavailable — skip cross-device sync.
  }
}

/** Mount once inside AuthGate to start the pref subscription + sync pass. */
export function AccountPrefsController() {
  useLunoraBetaPref();
  return null;
}
