/**
 * Lunora mutator checkpoint + optimistic-hold helpers (ADR 0055).
 *
 * Kept dependency-light so unit tests can pin the overlay/fallback policy
 * without standing up a full outline store.
 */

import type { lunoraCollectionOptions } from "@lunora/db";
import type { LunoraClient } from "lunorash/client";

export type CheckpointRegistry = ReturnType<
  typeof lunoraCollectionOptions
>["checkpoints"];

/**
 * TanStack DB's "direct" transaction flag (same key `collection.insert`/
 * `update` stamp). Completing `mutationFn` with no pending shape sync drops
 * optimistic rows as "stale" unless this is set — our checkpoint fallback
 * then reverts typed text to the old synced value.
 *
 * String literal on purpose: `@tanstack/db` doesn't re-export the constant
 * from its package root (lives under `collection/transaction-metadata`).
 */
export const DIRECT_TRANSACTION_METADATA_KEY = "__tanstack_db_direct";

/** Stamp TanStack's direct-tx flag before `mutationFn` settles. */
export function withDirectOptimisticMetadata<
  M extends Record<
    string,
    (args: never) => { metadata: Record<string, unknown> }
  >,
>(mutators: M): M {
  const bound = {} as M;
  for (const name of Object.keys(mutators) as Array<keyof M & string>) {
    const run = mutators[name]!;
    bound[name] = ((args: never) => {
      const tx = run(args);
      tx.metadata[DIRECT_TRANSACTION_METADATA_KEY] = true;
      return tx;
    }) as M[typeof name];
  }
  return bound;
}

/**
 * Hold optimistic overlays until the shape poke lands — NOT until RPC ack.
 *
 * Short-circuiting on `confirmedMutationWatermark` (RPC ack) drops the
 * overlay before `wholeOutline` has the new row. Always wait on the shape
 * gate first; if a poke is missed, fall back after the RPC ack so Today
 * can't hang forever. Paired with `withDirectOptimisticMetadata` so the
 * fallback doesn't revert typed text.
 */
export const SHAPE_CHECKPOINT_FALLBACK_MS = 3000;

export type ShapeFirstCheckpointsOpts = {
  /** Override for unit tests (default {@link SHAPE_CHECKPOINT_FALLBACK_MS}). */
  fallbackMs?: number;
};

export function shapeFirstCheckpoints(
  client: Pick<LunoraClient, "confirmedMutationWatermark">,
  shardKey: string,
  shape: CheckpointRegistry,
  opts: ShapeFirstCheckpointsOpts = {},
): CheckpointRegistry {
  const fallbackMs = opts.fallbackMs ?? SHAPE_CHECKPOINT_FALLBACK_MS;
  return {
    awaitCheckpoint: (cursor) => shape.awaitCheckpoint(cursor),
    resolve: (watermark) => shape.resolve(watermark),
    awaitMutationId: (id) => {
      let settled = false;
      return new Promise<void>((resolve) => {
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        // Shape wait failure must not become an unhandled rejection — the
        // RPC-watermark fallback below still settles the overlay.
        void shape.awaitMutationId(id).then(finish, () => undefined);

        const armFallback = () => {
          if (settled) return;
          if (id > client.confirmedMutationWatermark(shardKey)) {
            setTimeout(armFallback, 50);
            return;
          }
          setTimeout(() => {
            if (settled) return;
            shape.resolve({ mutationId: id });
            finish();
          }, fallbackMs);
        };
        armFallback();
      });
    },
  };
}
