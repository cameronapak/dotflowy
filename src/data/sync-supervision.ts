import { Cause, Duration } from "effect";
import { toast } from "sonner";

/**
 * Supervision policy for the inbound-sync consumer fiber (collection.ts).
 *
 * The consumer drains `Stream<SyncEvent>` and folds each frame into the TanStack
 * DB sync primitives via `applyMessage`. A throw inside `applyMessage` (today
 * near-unreachable — the wire schema and collection schema are field-for-field
 * identical, but any future drift is one bad frame away) would otherwise DIE the
 * fiber permanently: the WebSocket still looks connected, no frame is ever
 * applied again, and every structural write hangs its echo-wait to the 8s
 * timeout with no signal to the user. See issue #234 / ADR 0053.
 *
 * This module is the cheap supervision: a pure decision function (below) the
 * fiber consults on failure, plus the visible "reload" notice for the give-up
 * path. Keeping the policy pure is what makes it unit-testable without driving
 * the whole socket. The Effect wiring (catchCause + re-establish) lives at the
 * fork site in collection.ts.
 */

/** Max consecutive re-establish attempts before we stop retrying and flip to the
 *  visible "reload" state. Bounds the recovery so a DETERMINISTICALLY poisonous
 *  frame (one that re-poisons every snapshot) can't hot-loop snapshot fetches. */
export const SYNC_RECOVERY_BUDGET = 3;

/** Backoff floor + cap between re-establish attempts (jitter-free; the failure is
 *  rare and self-inflicted, so plain exponential is enough — no thundering herd). */
const RECOVERY_BASE = Duration.millis(500);
const RECOVERY_CAP = Duration.seconds(5);

/**
 * What the supervisor should do after the consumer fiber ends.
 *  - `Stop`        — an intentional interrupt (session cleanup, account switch).
 *                    Tear down quietly: NOT a fault, so never recover, never toast.
 *  - `Reestablish` — a genuine failure (a defect/throw) with budget left: log the
 *                    cause and re-open the stream after `delay` (a fresh snapshot
 *                    truncates + replaces the collection, healing a transient
 *                    one-frame glitch).
 *  - `GiveUp`      — budget exhausted: stop retrying and surface the visible
 *                    "sync interrupted — reload" notice so the session can't die
 *                    silently.
 */
export type SyncRecoveryDecision =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "Reestablish"; readonly delay: Duration.Duration }
  | { readonly _tag: "GiveUp" };

/**
 * Decide how to supervise the consumer fiber given the failure `cause` and how
 * many re-establishes have already been spent this streak. Pure: no clock, no
 * socket, no toast — just the policy, so the interrupt-vs-fault split and the
 * retry budget are pinned by unit tests (sync-supervision.test.ts).
 *
 * The interrupt check is load-bearing: `catchCause` sees interruptions too, and
 * cleanup tears the fiber down by interrupting it. An interrupt-only cause MUST
 * map to `Stop` so an intentional teardown never triggers recovery or the toast.
 */
export function decideSyncRecovery(
  cause: Cause.Cause<never>,
  recoveriesUsed: number,
  budget: number = SYNC_RECOVERY_BUDGET,
): SyncRecoveryDecision {
  if (Cause.hasInterruptsOnly(cause)) return { _tag: "Stop" };
  if (recoveriesUsed >= budget) return { _tag: "GiveUp" };
  const ms = Math.min(
    Duration.toMillis(RECOVERY_CAP),
    Duration.toMillis(RECOVERY_BASE) * 2 ** recoveriesUsed,
  );
  return { _tag: "Reestablish", delay: Duration.millis(ms) };
}

/**
 * The give-up notice: a persistent toast telling the user live sync stopped and
 * to reload. Reuses the same sonner mechanism as `notifySaveFailed` (#230) — a
 * fixed `id` de-dupes, and `duration: Infinity` keeps it on screen (a silently
 * dead sync fiber is exactly what #234 exists to prevent). The action reloads,
 * which re-runs the sync bootstrap from a clean slate.
 */
export function notifySyncInterrupted(): void {
  toast.error("Sync interrupted", {
    id: "sync-interrupted",
    duration: Infinity,
    description: "Live sync stopped unexpectedly. Reload to reconnect.",
    action: {
      label: "Reload",
      onClick: () => window.location.reload(),
    },
  });
}
