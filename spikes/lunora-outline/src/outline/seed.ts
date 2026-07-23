/**
 * Idempotent first-run demo seed.
 *
 * Idempotency is server-authoritative: `seedIfEmpty` loads the shard, no-ops if
 * any nodes exist, else inserts 4 demo bullets with **deterministic clientIds**.
 * Watermark FIFO on the DO serializes concurrent calls — the second sees
 * non-empty and no-ops. Client optimistic apply uses the same ids so multi-tab
 * overlays converge.
 */

import { makeNode } from "./tree.js";
import { emptyPlan, type OutlineNode, type OutlinePlan } from "./types.js";

export const DEMO_SEED_TEXTS = [
  "Welcome to the Lunora outline spike",
  "Open a second tab — edits sync live",
  "Try indent / outdent / delete",
  "Hard reload restores from wholeOutline",
] as const;

/**
 * Fixed UUID clientIds for the 4 demo bullets (shard-local).
 * Same ids every seed → multi-tab optimistic rows converge; second server call no-ops.
 */
export const DEMO_SEED_IDS = [
  "d0ef1001-5eed-4000-8000-000000000001",
  "d0ef1002-5eed-4000-8000-000000000002",
  "d0ef1003-5eed-4000-8000-000000000003",
  "d0ef1004-5eed-4000-8000-000000000004",
] as const;

export type SeedIfEmptyArgs = {
  userId: string;
  /** Base timestamp; bullet i uses createdAt/updatedAt = createdAt + i. */
  createdAt: number;
  texts?: readonly string[];
  ids?: readonly string[];
};

/** Gate: ready + zero nodes. Callers still guard in-flight / StrictMode. */
export function shouldSeedOutline(opts: {
  isReady: boolean;
  nodeCount: number;
}): boolean {
  return opts.isReady && opts.nodeCount === 0;
}

/**
 * Pure planner: empty outline → insert demo chain; non-empty → null (no-op).
 */
export function planSeedIfEmpty(
  nodes: readonly OutlineNode[],
  args: SeedIfEmptyArgs,
): OutlinePlan | null {
  if (nodes.length > 0) return null;

  const texts = args.texts ?? DEMO_SEED_TEXTS;
  const ids = args.ids ?? DEMO_SEED_IDS;
  if (texts.length !== ids.length) {
    throw new Error("planSeedIfEmpty: texts and ids length mismatch");
  }

  const plan = emptyPlan();
  let prev: string | null = null;
  for (let i = 0; i < texts.length; i++) {
    const id = ids[i]!;
    const t = args.createdAt + i;
    plan.inserts.push(
      makeNode({
        id,
        userId: args.userId,
        parentId: null,
        prevSiblingId: prev,
        text: texts[i]!,
        createdAt: t,
        updatedAt: t,
      }),
    );
    prev = id;
  }
  return plan;
}

export type SeedIfEmptyFn = (args: {
  userId: string;
  createdAt: number;
}) => Promise<unknown>;

/**
 * Fire the server-authoritative `seedIfEmpty` mutator (optimistic apply mirrors
 * `planSeedIfEmpty` with the same deterministic clientIds).
 */
export async function seedEmptyOutline(opts: {
  userId: string;
  seedIfEmpty: SeedIfEmptyFn;
  now?: () => number;
}): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  await opts.seedIfEmpty({
    userId: opts.userId,
    createdAt: now(),
  });
}
