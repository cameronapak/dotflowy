/**
 * Account-scoped preferences synced via classic DO `/api/kv` (ADR 0058 opt-in).
 *
 * Lunora beta opt-in lives here — not localStorage alone — so enabling on one
 * device can converge others on next load. The runtime flag still mirrors to
 * `dotflowy:flag:lunora-sync` so `LunoraSyncHost` remounts cleanly after reload.
 *
 * Inline agent (BETA) opt-in (ADR 0059) is the same shape, default OFF, and
 * does not reload — fire paths read it live via {@link isInlineAgentBetaEnabled}.
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
export const INLINE_AGENT_BETA_ROW_ID = "inline-agent-beta";

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

function prefRow(id: string): AccountPrefRow | null {
  return accountPrefsCollection.toArray.find((r) => r.id === id) ?? null;
}

function lunoraBetaRow(): AccountPrefRow | null {
  return prefRow(LUNORA_BETA_ROW_ID);
}

function inlineAgentBetaRow(): AccountPrefRow | null {
  return prefRow(INLINE_AGENT_BETA_ROW_ID);
}

function mirrorLunoraFlag(enabled: boolean) {
  try {
    window.localStorage.setItem(LUNORA_SYNC_FLAG_KEY, enabled ? "on" : "off");
  } catch {
    // Private mode — reload still picks up URL-less default until next success.
  }
}

/**
 * Persist the preference via a direct `kvPut` — not the collection's
 * insert/update handlers. Those fire async `onInsert`/`onUpdate` that
 * `hardReset` aborts mid-flight, so the synced row never lands.
 */
async function writeLunoraBeta(enabled: boolean): Promise<void> {
  const row: AccountPrefRow = { id: LUNORA_BETA_ROW_ID, enabled };
  await kvPut(KV, [{ key: LUNORA_BETA_ROW_ID, value: row }]);
}

/**
 * Persist Lunora beta opt-in, mirror the runtime flag, and reload.
 *
 * REJECTS on a failed write, and callers MUST handle that. The order is
 * load-bearing: the synced row lands first, so a rejection means the local
 * mirror was never touched and no reload happens — the app is still in its
 * previous, consistent state. Dropping the rejection (a bare `void`) leaves
 * the user with a switch that silently snaps back and no idea why.
 */
export async function setLunoraBetaEnabled(enabled: boolean): Promise<void> {
  await writeLunoraBeta(enabled);
  mirrorLunoraFlag(enabled);
  hardReset(window.location.pathname + window.location.search);
}

/**
 * Persist Inline agent (BETA) opt-in. No reload — fire paths read the live
 * collection. REJECTS on a failed write; callers must handle that.
 */
export async function setInlineAgentBetaEnabled(
  enabled: boolean,
): Promise<void> {
  const row: AccountPrefRow = { id: INLINE_AGENT_BETA_ROW_ID, enabled };
  await kvPut(KV, [{ key: INLINE_AGENT_BETA_ROW_ID, value: row }]);
  if (accountPrefsCollection.has(INLINE_AGENT_BETA_ROW_ID)) {
    accountPrefsCollection.update(
      INLINE_AGENT_BETA_ROW_ID,
      (draft) => void (draft.enabled = enabled),
    );
  } else {
    accountPrefsCollection.insert(row);
  }
}

/** Event-time read for fire paths. False until ready / missing row (default OFF). */
export function isInlineAgentBetaEnabled(): boolean {
  ensureStarted();
  if (!collectionReady) return false;
  return inlineAgentBetaRow()?.enabled === true;
}

// --- Reactive read -----------------------------------------------------------

const HIDDEN = { ready: false, enabled: false } as const;

type PrefSnapshot = { ready: boolean; enabled: boolean };

let lunoraSnapshot: PrefSnapshot = HIDDEN;
let inlineAgentSnapshot: PrefSnapshot = HIDDEN;
let collectionReady = false;
const listeners = new Set<() => void>();
let started = false;

function rebuild() {
  const lunoraOn = collectionReady
    ? (lunoraBetaRow()?.enabled ?? false)
    : false;
  const agentOn = collectionReady
    ? (inlineAgentBetaRow()?.enabled ?? false)
    : false;
  const lunoraChanged =
    lunoraSnapshot.ready !== collectionReady ||
    lunoraSnapshot.enabled !== lunoraOn;
  const agentChanged =
    inlineAgentSnapshot.ready !== collectionReady ||
    inlineAgentSnapshot.enabled !== agentOn;
  if (!lunoraChanged && !agentChanged) return;
  if (lunoraChanged) {
    lunoraSnapshot = { ready: collectionReady, enabled: lunoraOn };
  }
  if (agentChanged) {
    inlineAgentSnapshot = { ready: collectionReady, enabled: agentOn };
  }
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

function getLunoraSnapshot(): PrefSnapshot {
  ensureStarted();
  return lunoraSnapshot;
}

function getInlineAgentSnapshot(): PrefSnapshot {
  ensureStarted();
  return inlineAgentSnapshot;
}

/** Synced Lunora beta preference. `enabled` is false until the kv row loads. */
export function useLunoraBetaPref(): PrefSnapshot {
  return useSyncExternalStore(subscribe, getLunoraSnapshot, () => HIDDEN);
}

/** Synced Inline agent (BETA) preference. Default OFF until the kv row is on. */
export function useInlineAgentBetaPref(): PrefSnapshot {
  return useSyncExternalStore(subscribe, getInlineAgentSnapshot, () => HIDDEN);
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
  useInlineAgentBetaPref();
  return null;
}
