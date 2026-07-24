/**
 * Client outline store for the Lunora flag-swap path (ADR 0055).
 * `wholeOutline` shape + `bindMutators` with watermark checkpoints (replaces
 * `waitForSeq`).
 */

import type { LunoraClient } from "lunorash/client";

import { lunoraCollectionOptions } from "@lunora/db";
import { bindMutators, defineMutator } from "@lunora/db/mutators";
import { createCollection, type Collection } from "@tanstack/db";

import type {
  DailyIndexRowDoc,
  SavedQueryRowDoc,
  TagColorRowDoc,
} from "./lunora-kv-store";

import {
  shapeFirstCheckpoints,
  withDirectOptimisticMetadata,
  type CheckpointRegistry,
} from "./lunora-checkpoints";
import {
  buildTreeIndex,
  nodeToRow,
  planAppendChild,
  planImportNodes,
  planIndent,
  planIndentMany,
  planInsertChildAtStart,
  planInsertSibling,
  planMaterializeDailyNodes,
  planMirrorNode,
  planMoveMany,
  planMoveNode,
  planOutdent,
  planOutdentMany,
  planRemoveMany,
  planRemoveNode,
  planRestoreNodes,
  planSeedIfEmpty,
  planSetBookmarkedAt,
  planSetCollapsed,
  planSetCompleted,
  planSetIsTask,
  planSetKind,
  planSetText,
  planSplitNode,
  rowToNode,
  type NodeDocLike,
  type OutlineNode,
  type OutlinePlan,
} from "./outline-plans";

/**
 * Kv-only mutators poke their own shape, not `wholeOutline`. Fan those pokes
 * into the mutator gate so a shape-based wait can still complete (e2e force-
 * pokes `wholeOutline` for the same reason).
 */
function relayCheckpoints(
  from: CheckpointRegistry,
  to: CheckpointRegistry,
): void {
  const orig = from.resolve.bind(from);
  from.resolve = (watermark) => {
    orig(watermark);
    to.resolve(watermark);
  };
}

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
  /** Phase 2b — Lunora tag colors (flag ON). */
  tagColors: Collection<TagColorRowDoc, string>;
  /** Phase 2b — Lunora saved queries (flag ON). */
  savedQueries: Collection<SavedQueryRowDoc, string>;
  /** Phase 2b — Lunora daily index (flag ON). */
  dailyIndex: Collection<DailyIndexRowDoc, string>;
  mutators: ReturnType<typeof bindOutlineMutators>;
};

function bindOutlineMutators(
  client: LunoraClient,
  collection: Collection<NodeRow, string>,
  tagColors: Collection<TagColorRowDoc, string>,
  savedQueries: Collection<SavedQueryRowDoc, string>,
  dailyIndex: Collection<DailyIndexRowDoc, string>,
  checkpoints: ReturnType<
    typeof lunoraCollectionOptions<NodeRow>
  >["checkpoints"],
  userId: string,
) {
  return bindMutators(
    client,
    {
      checkpoints,
      collections: {
        nodes: collection as never,
        tagColors: tagColors as never,
        savedQueries: savedQueries as never,
        dailyIndex: dailyIndex as never,
      },
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
      insertChildAtStart: defineMutator<{
        id: string;
        userId: string;
        parentId: string | null;
        text: string;
        isTask?: boolean;
        kind?: "paragraph" | null;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:insertChildAtStart",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planInsertChildAtStart(index, args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      appendChild: defineMutator<{
        id: string;
        userId: string;
        parentId: string | null;
        text: string;
        isTask?: boolean;
        kind?: "paragraph" | null;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:appendChild",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planAppendChild(index, args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      importNodes: defineMutator<{
        userId: string;
        nodes: OutlineNode[];
      }>({
        serverRef: "mutators:importNodes",
        apply: (_ctx, args) => {
          applyPlanToCollection(collection, planImportNodes(args.nodes));
        },
      }),
      splitNode: defineMutator<{
        id: string;
        newId: string;
        userId: string;
        parentId: string | null;
        afterId: string;
        leftText: string;
        rightText: string;
        isTask?: boolean;
        kind?: "paragraph" | null;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:splitNode",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSplitNode(index, args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      indent: defineMutator<{
        id: string;
        userId: string;
        updatedAt: number;
        resolveMirror?: boolean;
      }>({
        serverRef: "mutators:indent",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planIndent(
            index,
            args.id,
            args.updatedAt,
            args.resolveMirror ?? false,
          );
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
      moveNode: defineMutator<{
        id: string;
        userId: string;
        newParentId: string | null;
        afterSiblingId: string | null;
        updatedAt: number;
        expandIds?: string[];
      }>({
        serverRef: "mutators:moveNode",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planMoveNode(index, args);
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
      setCompleted: defineMutator<{
        id: string;
        userId: string;
        completed: boolean;
        updatedAt: number;
      }>({
        serverRef: "mutators:setCompleted",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetCompleted(
            index,
            args.id,
            args.completed,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      setCollapsed: defineMutator<{
        id: string;
        userId: string;
        collapsed: boolean;
        updatedAt: number;
      }>({
        serverRef: "mutators:setCollapsed",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetCollapsed(
            index,
            args.id,
            args.collapsed,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      setIsTask: defineMutator<{
        id: string;
        userId: string;
        isTask: boolean;
        updatedAt: number;
      }>({
        serverRef: "mutators:setIsTask",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetIsTask(
            index,
            args.id,
            args.isTask,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      setKind: defineMutator<{
        id: string;
        userId: string;
        kind: "paragraph" | null;
        updatedAt: number;
      }>({
        serverRef: "mutators:setKind",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetKind(index, args.id, args.kind, args.updatedAt);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      setBookmarkedAt: defineMutator<{
        id: string;
        userId: string;
        bookmarkedAt: number | null;
        updatedAt: number;
      }>({
        serverRef: "mutators:setBookmarkedAt",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planSetBookmarkedAt(
            index,
            args.id,
            args.bookmarkedAt,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      restoreNodes: defineMutator<{
        userId: string;
        nodes: OutlineNode[];
      }>({
        serverRef: "mutators:restoreNodes",
        apply: (_ctx, args) => {
          const plan = planRestoreNodes(snapshotNodes(collection), args.nodes);
          applyPlanToCollection(collection, plan);
        },
      }),
      mirrorNode: defineMutator<{
        id: string;
        userId: string;
        sourceId: string;
        targetParentId: string | null;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:mirrorNode",
        apply: (_ctx, args) => {
          const index = buildTreeIndex(snapshotNodes(collection));
          const plan = planMirrorNode(index, args);
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      removeMany: defineMutator<{
        userId: string;
        nodeIds: string[];
        updatedAt: number;
      }>({
        serverRef: "mutators:removeMany",
        apply: (_ctx, args) => {
          const plan = planRemoveMany(
            snapshotNodes(collection),
            args.nodeIds,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      moveMany: defineMutator<{
        userId: string;
        targetId: string | null;
        nodeIds: string[];
        updatedAt: number;
      }>({
        serverRef: "mutators:moveMany",
        apply: (_ctx, args) => {
          const plan = planMoveMany(snapshotNodes(collection), {
            targetId: args.targetId,
            nodeIds: args.nodeIds,
            updatedAt: args.updatedAt,
          });
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      indentMany: defineMutator<{
        userId: string;
        nodeIds: string[];
        updatedAt: number;
        resolveMirror?: boolean;
      }>({
        serverRef: "mutators:indentMany",
        apply: (_ctx, args) => {
          const plan = planIndentMany(
            snapshotNodes(collection),
            args.nodeIds,
            args.updatedAt,
            args.resolveMirror ?? false,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      outdentMany: defineMutator<{
        userId: string;
        nodeIds: string[];
        updatedAt: number;
      }>({
        serverRef: "mutators:outdentMany",
        apply: (_ctx, args) => {
          const plan = planOutdentMany(
            snapshotNodes(collection),
            args.nodeIds,
            args.updatedAt,
          );
          if (plan) applyPlanToCollection(collection, plan);
        },
      }),
      materializeDailyNodes: defineMutator<{
        userId: string;
        inserts: Array<{
          id: string;
          parentId: string | null;
          afterId: string | null;
          text: string;
        }>;
        createdAt: number;
        updatedAt: number;
      }>({
        serverRef: "mutators:materializeDailyNodes",
        apply: (_ctx, args) => {
          const plan = planMaterializeDailyNodes(
            snapshotNodes(collection),
            args,
          );
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
      // --- phase 2b kv (same clientSeq FIFO as outline) ---
      upsertTagColor: defineMutator<{
        userId: string;
        tag: string;
        color: string;
      }>({
        serverRef: "mutators:upsertTagColor",
        apply: (_ctx, args) => {
          if (tagColors.has(args.tag)) {
            tagColors.update(args.tag, (draft) => {
              draft.color = args.color;
            });
          } else {
            tagColors.insert({
              _id: args.tag,
              tag: args.tag,
              color: args.color,
              userId: args.userId,
              _creationTime: Date.now(),
            });
          }
        },
      }),
      deleteTagColor: defineMutator<{ userId: string; tag: string }>({
        serverRef: "mutators:deleteTagColor",
        apply: (_ctx, args) => {
          if (tagColors.has(args.tag)) tagColors.delete(args.tag);
        },
      }),
      upsertSavedQuery: defineMutator<{
        userId: string;
        id: string;
        name: string;
        query: string;
        createdAt: number;
      }>({
        serverRef: "mutators:upsertSavedQuery",
        apply: (_ctx, args) => {
          if (savedQueries.has(args.id)) {
            savedQueries.update(args.id, (draft) => {
              draft.name = args.name;
              draft.query = args.query;
              draft.createdAt = args.createdAt;
            });
          } else {
            savedQueries.insert({
              _id: args.id,
              name: args.name,
              query: args.query,
              createdAt: args.createdAt,
              userId: args.userId,
              _creationTime: args.createdAt,
            });
          }
        },
      }),
      patchSavedQuery: defineMutator<{
        userId: string;
        id: string;
        name?: string;
        query?: string;
      }>({
        serverRef: "mutators:patchSavedQuery",
        apply: (_ctx, args) => {
          if (!savedQueries.has(args.id)) return;
          savedQueries.update(args.id, (draft) => {
            if (args.name !== undefined) draft.name = args.name;
            if (args.query !== undefined) draft.query = args.query;
          });
        },
      }),
      deleteSavedQueryRow: defineMutator<{ userId: string; id: string }>({
        serverRef: "mutators:deleteSavedQuery",
        apply: (_ctx, args) => {
          if (savedQueries.has(args.id)) savedQueries.delete(args.id);
        },
      }),
      // --- dailyIndex ---
      claimDailyMapping: defineMutator<{
        userId: string;
        key: string;
        nodeId: string;
        touchedAt: number;
      }>({
        serverRef: "mutators:claimDailyMapping",
        apply: (_ctx, args) => {
          if (dailyIndex.has(args.key)) {
            // Keep existing nodeId (pre-existing wins); bump touchedAt.
            dailyIndex.update(args.key, (draft) => {
              draft.touchedAt = args.touchedAt;
            });
            return;
          }
          dailyIndex.insert({
            _id: args.key,
            key: args.key,
            nodeId: args.nodeId,
            touchedAt: args.touchedAt,
            userId: args.userId,
            _creationTime: args.touchedAt,
          });
        },
      }),
      upsertDailyMapping: defineMutator<{
        userId: string;
        key: string;
        nodeId: string;
        touchedAt: number;
      }>({
        serverRef: "mutators:upsertDailyMapping",
        apply: (_ctx, args) => {
          if (dailyIndex.has(args.key)) {
            dailyIndex.update(args.key, (draft) => {
              draft.nodeId = args.nodeId;
              draft.touchedAt = args.touchedAt;
            });
          } else {
            dailyIndex.insert({
              _id: args.key,
              key: args.key,
              nodeId: args.nodeId,
              touchedAt: args.touchedAt,
              userId: args.userId,
              _creationTime: args.touchedAt,
            });
          }
        },
      }),
      deleteDailyMapping: defineMutator<{ userId: string; key: string }>({
        serverRef: "mutators:deleteDailyMapping",
        apply: (_ctx, args) => {
          if (dailyIndex.has(args.key)) dailyIndex.delete(args.key);
        },
      }),
    },
  );
}

/** Build outline + phase-2b kv collections + one bound mutator surface. */
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
  const tagOpts = lunoraCollectionOptions<TagColorRowDoc>({
    client,
    id: `tagColors:${userId}`,
    // Natural key = tag (server `_id` is a UUID — tag names aren't valid clientIds).
    getKey: (row) => row.tag,
    shape: {
      name: "userTagColors",
      args: { userId },
      shardKey: userId,
    },
    load: "eager",
  });
  const savedOpts = lunoraCollectionOptions<SavedQueryRowDoc>({
    client,
    id: `savedQueries:${userId}`,
    shape: {
      name: "userSavedQueries",
      args: { userId },
      shardKey: userId,
    },
    load: "eager",
  });
  const dailyOpts = lunoraCollectionOptions<DailyIndexRowDoc>({
    client,
    id: `dailyIndex:${userId}`,
    // Natural key = scaffold/day key (server `_id` is a UUID).
    getKey: (row) => row.key,
    shape: {
      name: "userDailyIndex",
      args: { userId },
      shardKey: userId,
    },
    load: "eager",
  });

  // Fan side-collection shape pokes into the wholeOutline gate (belt for the
  // offline/outbox path where RPC ack hasn't advanced the watermark yet).
  relayCheckpoints(tagOpts.checkpoints, checkpoints);
  relayCheckpoints(savedOpts.checkpoints, checkpoints);
  relayCheckpoints(dailyOpts.checkpoints, checkpoints);

  const collection = createCollection(config);
  const tagColors = createCollection(tagOpts.config);
  const savedQueries = createCollection(savedOpts.config);
  const dailyIndex = createCollection(dailyOpts.config);
  // Shared clientSeq FIFO; hold overlays until shape poke (shapeFirstCheckpoints).
  // Stamp TanStack "direct" metadata so a missed shape poke's 3s fallback
  // doesn't drop optimistic typed text as stale.
  const mutators = withDirectOptimisticMetadata(
    bindOutlineMutators(
      client,
      collection,
      tagColors,
      savedQueries,
      dailyIndex,
      shapeFirstCheckpoints(client, userId, checkpoints),
      userId,
    ),
  );
  return { collection, tagColors, savedQueries, dailyIndex, mutators };
}
