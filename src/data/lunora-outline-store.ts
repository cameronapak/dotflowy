/**
 * Client outline store for the Lunora flag-swap path (ADR 0055).
 * Ported from `spikes/lunora-outline/src/outline-store.ts` — `wholeOutline`
 * shape + `bindMutators` with watermark checkpoints (replaces `waitForSeq`).
 */

import type { LunoraClient } from "lunorash/client";

import { lunoraCollectionOptions } from "@lunora/db";
import { bindMutators, defineMutator } from "@lunora/db/mutators";
import { createCollection, type Collection } from "@tanstack/db";

import {
  buildTreeIndex,
  nodeToRow,
  planIndent,
  planInsertSibling,
  planOutdent,
  planRemoveNode,
  planSeedIfEmpty,
  planSetText,
  rowToNode,
  type NodeDocLike,
  type OutlineNode,
  type OutlinePlan,
} from "./outline-plans";

/** Row shape for TanStack — Lunora Doc + index signature for collection drafts. */
export type NodeRow = NodeDocLike &
  Record<string, unknown> & { _creationTime?: number };

function applyPlanToCollection(
  collection: Collection<NodeRow, string>,
  plan: OutlinePlan,
): void {
  for (const id of plan.deletes) {
    collection.delete(id);
  }
  for (const patch of plan.patches) {
    collection.update(patch.id, (draft) => {
      Object.assign(draft, patch.fields);
    });
  }
  for (const insert of plan.inserts) {
    collection.insert(nodeToRow(insert) as NodeRow);
  }
}

function snapshotNodes(collection: Collection<NodeRow, string>): OutlineNode[] {
  return collection.toArray.map(rowToNode);
}

export type OutlineStore = {
  collection: Collection<NodeRow, string>;
  mutators: ReturnType<typeof bindOutlineMutators>;
};

function bindOutlineMutators(
  client: LunoraClient,
  collection: Collection<NodeRow, string>,
  checkpoints: ReturnType<
    typeof lunoraCollectionOptions<NodeRow>
  >["checkpoints"],
  userId: string,
) {
  return bindMutators(
    client,
    {
      checkpoints,
      collections: { nodes: collection as never },
      shardKey: userId,
    },
    {
      insertSibling: defineMutator<{
        id: string;
        userId: string;
        parentId: string | null;
        afterId: string | null;
        text: string;
        isTask?: boolean;
        kind?: "paragraph" | null;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:insertSibling",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planInsertSibling(index, args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      indent: defineMutator<{ id: string; userId: string; updatedAt: number }>({
        serverRef: "mutators:indent",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planIndent(index, args.id, args.updatedAt);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      outdent: defineMutator<{ id: string; userId: string; updatedAt: number }>(
        {
          serverRef: "mutators:outdent",
          apply: (_ctx, args) => {
            const index = buildTreeIndex(snapshotNodes(collection));
            const plan = planOutdent(index, args.id, args.updatedAt);
            if (plan) applyPlanToCollection(collection, plan);
          },
        },
      ),
      removeNode: defineMutator<{
        id: string;
        userId: string;
        updatedAt: number;
      }>({
        serverRef: "mutators:removeNode",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planRemoveNode(index, args.id, args.updatedAt);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      setText: defineMutator<{
        id: string;
        userId: string;
        text: string;
        updatedAt: number;
      }>({
        serverRef: "mutators:setText",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetText(index, args.id, args.text, args.updatedAt);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      seedIfEmpty: defineMutator<{ userId: string; createdAt: number }>({
        serverRef: "mutators:seedIfEmpty",
        apply: (_ctx, args) => {
          const plan = planSeedIfEmpty(snapshotNodes(collection), args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
    },
  );
}

/** Build the outline collection + bound mutators for one signed-in user. */
export function createOutlineStore(
  client: LunoraClient,
  userId: string,
): OutlineStore {
  const { config, checkpoints } = lunoraCollectionOptions<NodeRow>({
    client,
    id: `nodes:${userId}`,
    shape: {
      name: "wholeOutline",
      args: { userId },
      shardKey: userId,
    },
    load: "eager",
  });

  const collection = createCollection(config);
  const mutators = bindOutlineMutators(client, collection, checkpoints, userId);
  return { collection, mutators };
}
