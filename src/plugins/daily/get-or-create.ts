// The daily-note get-or-create engine (ADR 0001 / 0041 / 0052), extracted from
// `index.tsx` so BOTH the plugin definition and the week-calendar subheader
// strip (ADR 0054) can import `goToDate` without an import cycle (index.tsx
// imports the strip for its slot; the strip imports nav from here). Behavior is
// byte-identical to when this lived in index.tsx.
//
// The cascade is CLAIM-FIRST: when the local replica shows a scaffold/day node
// absent, mint a candidate id and run it through the atomic `claimMapping`. The
// claim winner id is authoritative; missing node rows are materialized locally
// under that id in ONE structural batch (ADR 0009) -- claims resolve up front and
// concurrently, then a single synchronous body materializes every missing level
// + the day + the optional seed. The fast path (today already in the local
// replica) stays synchronous-quick with no scaffold round-trip. See daily-index.ts.

import { toast } from "sonner";

import type { PluginContext } from "../types";

import { setRestoreProgress } from "../../components/history-restore";
import { resyncNodes } from "../../data/collection";
import {
  dayKeyToScaffoldChain,
  parentScaffoldKey,
  scaffoldLabel,
} from "../../data/date-links";
import { isLunoraSyncEnabled } from "../../data/flags";
import { RESTORE_SLICE_OPS, capture } from "../../data/history";
import { getLiveNodes } from "../../data/live-nodes";
import { getLunoraOutlineContext } from "../../data/lunora-sync";
import {
  appendChild,
  insertChildAtStart,
  insertSibling,
  moveNode,
  setText,
} from "../../data/mutations";
import { isNodesLimitError } from "../../data/nodes-client-effect";
import {
  applyPlan,
  buildTreeIndex,
  childrenOf,
  planInsertSibling,
  rowToNode,
  type OutlineNode,
} from "../../data/outline-plans";
import {
  runStructural,
  runStructuralSliced,
  runStructuralTracked,
} from "../../data/structural";
import { createId } from "../../data/tree";
import { getTreeIndex } from "../../data/tree-store";
import {
  CONTAINER_KEY,
  DAILY_CONTAINER_TEXT,
  claimMapping,
  formatDayText,
  getDailyRows,
  getKeyForNode,
  getMappedId,
  refreshDailyIndex,
  setMapping,
} from "./daily-index";
import { withDailyNavigation } from "./pending";
import {
  type DailyMigrationPlan,
  inScaffoldScope,
  planDailyMigration,
  sortedInsertAfterId,
} from "./scaffold";

// --- get-or-create ----------------------------------------------------------

function liveOutlineNodes(): OutlineNode[] | null {
  if (!isLunoraSyncEnabled()) return null;
  const lunora = getLunoraOutlineContext();
  if (!lunora) return null;
  return lunora.store.collection.toArray.map(rowToNode);
}

function hasNode(id: string): boolean {
  const lunoraNodes = liveOutlineNodes();
  if (lunoraNodes) return lunoraNodes.some((n) => n.id === id);
  return getLiveNodes().some((n) => n.id === id);
}

/** One atomic claim for a scaffold/day key: the authoritative id, whether this
 *  caller won it, and whether its node row is already local. The fast path (a
 *  known-and-present mapping) skips the network round-trip entirely. */
async function claimScaffoldNode(
  key: string,
): Promise<{ id: string; won: boolean; present: boolean }> {
  const existing = getMappedId(key);
  if (existing && hasNode(existing))
    return { id: existing, won: false, present: true };
  const candidate = createId();
  const { winner, won } = await claimMapping(key, candidate);
  setMapping(key, winner);
  return { id: winner, won, present: hasNode(winner) };
}

// --- scaffold cascade (issue #271): Daily > YYYY > Month > Week > Day --------

/**
 * Splice a scaffold / day node (id `id`, text `text`) under `parentNodeId` at
 * its chronological slot (decision 4), relinking the sibling chain. Rebuilds the
 * index from the LIVE collection so successive splices in one batch read each
 * other's optimistic writes (the in-place-index caveat) -- the same discipline
 * `moveManyNodes` follows. Must run inside `runStructural` (ADR 0009).
 */
function insertScaffoldNode(
  parentNodeId: string,
  key: string,
  text: string,
  id: string,
): void {
  const index = buildTreeIndex(getLiveNodes());
  const siblings = childrenOf(index, parentNodeId).map((n) => ({
    id: n.id,
    key: getKeyForNode(n.id),
  }));
  const afterId = sortedInsertAfterId(siblings, key);
  if (afterId === null) {
    insertChildAtStart(index, parentNodeId, false, text, id);
  } else {
    insertSibling(index, parentNodeId, afterId, false, text, null, id);
  }
}

/** Heal an EXISTING day note (a pre-migration flat day, or an already-nested
 *  one): restore a blanked title and seed the entry line if a write-intent
 *  surface asked. NEVER scaffolds -- placement is the migration's job (finding
 *  3, mirroring the Worker's `planEnsureDaily` early-return). Reads the LIVE
 *  collection so the seed check can't trust a stale snapshot. */
function healExistingDay(
  dayId: string,
  key: string,
  seedEntryLine: boolean,
): void {
  const lunoraNodes = liveOutlineNodes();
  const node = lunoraNodes
    ? lunoraNodes.find((n) => n.id === dayId)
    : getLiveNodes().find((n) => n.id === dayId);
  if (node && !node.text.trim()) setText(dayId, formatDayText(key));
  // Seeding is opt-in at the OPEN boundary (ADR 0041): only a write-intent
  // surface (/today, Today button, Cmd+K "Go to Today") asks for an empty line.
  // A reopened-but-emptied day re-seeds in its own isolated batch. No capture()
  // -- stays out of undo like day creation.
  if (seedEntryLine && !hasChildInLiveCollection(dayId)) {
    // Lunora: insertChildAtStart is already a watermarked mutator; classic
    // path keeps runStructural + appendChild (last-child when empty = same).
    if (isLunoraSyncEnabled()) {
      insertChildAtStart(getTreeIndex(), dayId, false, "");
    } else {
      runStructural(() => appendChild(dayId, null, ""));
    }
  }
}

/** Outcome of a day get-or-create. `id` non-null = the durable day node. `id`
 *  null = the create failed and rolled back; `cause` is the persist rejection
 *  (null on the echo-missing tail) so callers can distinguish the free-tier
 *  ceiling (#170, `isNodesLimitError` -- its upgrade toast ALREADY fired, F3)
 *  and quick-add's Seam-L rejection can rethrow the REAL NodesLimitError.
 *  Contained to this module; {@link getOrCreateDay} translates it back to
 *  `string | null` for external callers. */
type NewDayResult = { id: string } | { id: null; cause: unknown };

/**
 * Materialize a genuinely NEW day and whichever calendar levels above it are
 * missing, in ONE structural batch (ADR 0009). Called only when the day node is
 * absent, so an existing day never leaves dangling Y/M/W mappings (finding 3).
 *
 * Claims container/year/month/week/day concurrently up front (finding 2/8a --
 * per-key atomic, so issuing them together only saves round-trips), fires at most
 * ONE resync when a lost claim's node hasn't synced yet (finding 5 -- no
 * per-level 1500ms waits; the batch materializes missing rows under the claimed
 * ids regardless), then a single synchronous body inserts every absent level
 * parents-first + the sorted-inserted day + the optional seed.
 */
async function materializeNewDay(
  container: { id: string; won: boolean; present: boolean },
  day: { id: string; won: boolean; present: boolean },
  key: string,
  seedEntryLine: boolean,
): Promise<NewDayResult> {
  // The day is absent -> derive + claim its Y/M/W chain (concurrently). A
  // non-calendar key (defensive) lands the day directly under the container.
  const chain = dayKeyToScaffoldChain(key);
  const levels = chain
    ? await Promise.all([
        claimScaffoldNode(chain.yearKey),
        claimScaffoldNode(chain.monthKey),
        claimScaffoldNode(chain.weekKey),
      ])
    : null;
  const [year, month, week] = levels ?? [null, null, null];

  // One resync when any lost-claim node isn't local yet; materialization below
  // (upsert under the claimed id) is what guarantees correctness, so no waits.
  const claimed = [container, day, year, month, week].filter(
    (c): c is { id: string; won: boolean; present: boolean } => c != null,
  );
  if (claimed.some((c) => !c.won && !c.present)) resyncNodes();

  const parentId = chain && week ? week.id : container.id;

  // ADR 0055: flag ON → one Lunora mutator for all node writes (kv claims
  // already done above). Classic path keeps runStructuralTracked + applyBatch.
  if (isLunoraSyncEnabled()) {
    return materializeNewDayLunora({
      container,
      day,
      key,
      seedEntryLine,
      chain,
      year,
      month,
      week,
      parentId,
    });
  }

  const { persisted } = runStructuralTracked(() => {
    // Container: appended at the end of the top level (special, not sorted).
    if (!hasNode(container.id)) {
      const tops = childrenOf(buildTreeIndex(getLiveNodes()), null);
      const after = tops.length ? tops[tops.length - 1]!.id : null;
      appendChild(null, after, DAILY_CONTAINER_TEXT, container.id);
    }
    // Year > Month > Week: sorted-inserted, parents-first, only when missing.
    if (chain && year && month && week) {
      if (!hasNode(year.id))
        insertScaffoldNode(
          container.id,
          chain.yearKey,
          scaffoldLabel(chain.yearKey),
          year.id,
        );
      if (!hasNode(month.id))
        insertScaffoldNode(
          year.id,
          chain.monthKey,
          scaffoldLabel(chain.monthKey),
          month.id,
        );
      if (!hasNode(week.id))
        insertScaffoldNode(
          month.id,
          chain.weekKey,
          scaffoldLabel(chain.weekKey),
          week.id,
        );
    }
    // The day itself, sorted chronologically among its week's day-children.
    if (!hasNode(day.id))
      insertScaffoldNode(parentId, key, formatDayText(key), day.id);
    // Seed the entry line in the SAME batch when a write-intent surface asked.
    if (seedEntryLine && !hasChildInLiveCollection(day.id))
      appendChild(day.id, null, "");
  });
  // Phantom-success guard (#233): the optimistic overlay makes `hasNode(day.id)`
  // true the instant the batch applies, so returning the id off it would let a
  // caller `setMapping` + navigate to a day that VANISHES on a failed send. Gate
  // the ok-return on the batch's durable echo (the OPML-import discipline, ADR
  // 0037). Two null paths, both reported honestly:
  //   1. PERSIST REJECTED -> the send failed and the overlay rolled back, so
  //      nothing landed. `cause` carries the rejection so each caller can make
  //      its OWN cap-vs-generic toast call (F3) and quick-add's Seam-L rejection
  //      can rethrow a real NodesLimitError.
  //   2. ECHO MISSING -> persist resolved but waitForSeqE COMPLETES on its 8s
  //      timeout without failing (collection.ts), so `hasNode(day.id)` can be
  //      false though the POST committed. `resyncNodes()` self-heals (the durable
  //      mapping makes the next attempt succeed); a null `cause` = non-cap (F4).
  try {
    await persisted;
  } catch (err) {
    return { id: null, cause: err };
  }
  if (hasNode(day.id)) return { id: day.id };
  resyncNodes();
  return { id: null, cause: null };
}

/** Lunora flag-ON materialize: plan inserts client-side (sorted afterIds), one
 *  `materializeDailyNodes` mutator, await watermark. Ids claimed via Lunora
 *  `claimDailyMapping` (daily-index bind) before this runs. */
async function materializeNewDayLunora(args: {
  container: { id: string; won: boolean; present: boolean };
  day: { id: string; won: boolean; present: boolean };
  key: string;
  seedEntryLine: boolean;
  chain: ReturnType<typeof dayKeyToScaffoldChain>;
  year: { id: string; won: boolean; present: boolean } | null;
  month: { id: string; won: boolean; present: boolean } | null;
  week: { id: string; won: boolean; present: boolean } | null;
  parentId: string;
}): Promise<NewDayResult> {
  const lunora = getLunoraOutlineContext();
  if (!lunora) return { id: null, cause: null };

  const t = Date.now();
  let working = lunora.store.collection.toArray.map(rowToNode);
  const inserts: Array<{
    id: string;
    parentId: string | null;
    afterId: string | null;
    text: string;
  }> = [];

  const pushInsert = (
    id: string,
    parentId: string | null,
    afterId: string | null,
    text: string,
  ) => {
    if (working.some((n) => n.id === id)) return;
    const step = planInsertSibling(buildTreeIndex(working), {
      id,
      userId: lunora.userId,
      parentId,
      afterId,
      text,
      createdAt: t,
      updatedAt: t,
    });
    if (!step) return;
    inserts.push({ id, parentId, afterId, text });
    working = applyPlan(working, step);
  };

  const pushSorted = (
    parentNodeId: string,
    scaffoldKey: string,
    text: string,
    id: string,
  ) => {
    if (working.some((n) => n.id === id)) return;
    const index = buildTreeIndex(working);
    const siblings = childrenOf(index, parentNodeId).map((n) => ({
      id: n.id,
      key: getKeyForNode(n.id),
    }));
    const afterId = sortedInsertAfterId(siblings, scaffoldKey);
    pushInsert(id, parentNodeId, afterId, text);
  };

  if (!working.some((n) => n.id === args.container.id)) {
    const tops = childrenOf(buildTreeIndex(working), null);
    const after = tops.length ? tops[tops.length - 1]!.id : null;
    pushInsert(args.container.id, null, after, DAILY_CONTAINER_TEXT);
  }

  if (args.chain && args.year && args.month && args.week) {
    pushSorted(
      args.container.id,
      args.chain.yearKey,
      scaffoldLabel(args.chain.yearKey),
      args.year.id,
    );
    pushSorted(
      args.year.id,
      args.chain.monthKey,
      scaffoldLabel(args.chain.monthKey),
      args.month.id,
    );
    pushSorted(
      args.month.id,
      args.chain.weekKey,
      scaffoldLabel(args.chain.weekKey),
      args.week.id,
    );
  }

  pushSorted(args.parentId, args.key, formatDayText(args.key), args.day.id);

  // ADR 0041 seedEntryLine: empty child in the SAME mutator when asked.
  if (args.seedEntryLine && !working.some((n) => n.parentId === args.day.id)) {
    pushInsert(createId(), args.day.id, null, "");
  }

  if (inserts.length === 0) {
    // Day already present after concurrent heal — treat as success.
    return hasNode(args.day.id)
      ? { id: args.day.id }
      : { id: null, cause: null };
  }

  const tx = lunora.store.mutators.materializeDailyNodes({
    userId: lunora.userId,
    inserts,
    createdAt: t,
    updatedAt: t,
  });
  try {
    await tx.isPersisted.promise;
  } catch (err) {
    return { id: null, cause: err };
  }
  if (hasNode(args.day.id)) return { id: args.day.id };
  resyncNodes();
  return { id: null, cause: null };
}

/** Does `parentId` have any child in the LIVE nodes collection? Used for the
 *  reopen-seed check, which must not trust a possibly-stale tree index. */
function hasChildInLiveCollection(parentId: string): boolean {
  const lunoraNodes = liveOutlineNodes();
  if (lunoraNodes) return lunoraNodes.some((n) => n.parentId === parentId);
  return getLiveNodes().some((n) => n.parentId === parentId);
}

// --- one-time flat -> nested migration (issue #271, decision 8) --------------

// Legacy accounts have every day sitting DIRECTLY under the "Daily" container.
// The first daily-note touch after ship nests them into Daily > Y > M > W and
// sorts ascending -- ONE undoable batch, derivable entirely from the daily index
// (every day key -> nodeId is known). Automatic, no prompt (a declined prompt
// would leave a permanently half-structured container). Idempotent: it re-detects
// flat days each session and no-ops a fully-nested outline; a brand-new empty
// account has no days, so it never runs.

/** In-flight / completed migration for this session. Non-null once a needed run
 *  starts, so concurrent daily touches share it; reset to null on failure so the
 *  next touch retries. A successful run leaves the resolved promise, and the
 *  post-migration outline is no longer flat, so it never re-runs. */
let dailyMigration: Promise<void> | null = null;

/** Run the migration ONCE per session if any legacy flat day exists.
 *
 *  The `not needed` result is NOT cached (a no-op run never sets
 *  `dailyMigration`): an outline that's still flat on this touch -- because the
 *  index hadn't loaded on an earlier one -- re-probes and migrates on the next.
 *  The probe is cheap because `planDailyMigration` scans only the mapped DAY
 *  ROWS (not the whole outline) with an O(1) `getKeyForNode`.
 *
 *  A SUCCESSFUL run, by contrast, IS cached for the rest of the session (the
 *  resolved promise stays non-null). So undoing the auto-migration and
 *  re-entering `/today` does NOT re-migrate -- deliberate: re-doing an explicit
 *  Cmd+Z is hostile. (Reappears next session if the outline is still flat.) */
async function ensureDailyMigrated(containerId: string): Promise<void> {
  if (dailyMigration) return dailyMigration;
  const plan = planDailyMigration(
    buildTreeIndex(getLiveNodes()),
    containerId,
    getDailyRows(),
    getKeyForNode,
  );
  if (!plan.needed) return;
  dailyMigration = runDailyMigration(containerId, plan).catch((err) => {
    dailyMigration = null; // let the next daily touch retry a failed run
    console.warn("daily: scaffold migration failed", err);
  });
  return dailyMigration;
}

/** Move a day node to its chronological slot under `weekId` -- one `moveNode`
 *  against a freshly rebuilt index (the in-place-index caveat). Already-correct
 *  placement is a harmless no-op. Runs inside the migration's `runStructural`.
 *  Revalidates at apply time (finding 4): the plan was computed before the async
 *  claims, so it skips a day that vanished or that the user relocated OUT of the
 *  Daily scaffold in that window rather than reversing the move. */
function moveDaySorted(
  dayNodeId: string,
  weekId: string,
  containerId: string,
): void {
  const index = buildTreeIndex(getLiveNodes());
  const day = index.byId.get(dayNodeId);
  if (!day) return; // deleted between plan and apply
  const dayKey = getKeyForNode(dayNodeId);
  if (!dayKey) return;
  if (!inScaffoldScope(index, day, containerId, getKeyForNode)) return;
  const siblings = childrenOf(index, weekId)
    .filter((n) => n.id !== dayNodeId)
    .map((n) => ({ id: n.id, key: getKeyForNode(n.id) }));
  moveNode(index, dayNodeId, weekId, sortedInsertAfterId(siblings, dayKey));
}

/**
 * Execute a needed {@link DailyMigrationPlan}. Two phases so the whole thing is
 * ONE undoable batch (async claims can't live inside the synchronous
 * `runStructural` body):
 *   1. Resolve every scaffold node id up front via atomic claims (get-or-create,
 *      so a node another device already made is reused, not duplicated).
 *   2. Materialize the missing scaffold nodes (parents-first) and reparent every
 *      day under its week, all chronologically sorted, in one structural batch --
 *      `capture()` snapshots the pre-migration tree so a single Cmd+Z reverts it.
 *      Streams through `runStructuralSliced` when large (RESTORE_SLICE_OPS).
 */
async function runDailyMigration(
  containerId: string,
  plan: DailyMigrationPlan,
): Promise<void> {
  // Phase 1: claim ids for every needed scaffold key. Claims are per-key atomic
  // and independent, so run them CONCURRENTLY (finding 5 -- after an undo the
  // scaffold mappings point at deleted nodes, and serial claims paid a full RTT
  // per key). No per-key `waitForNode`: phase 2 materializes any missing node
  // under its claimed id regardless, so waiting is pure loss. A single resync
  // (when anything is missing) nudges genuinely-remote nodes in for the NEXT
  // touch without stalling this one.
  const claims = await Promise.all(
    plan.scaffoldKeys.map(async (key) => {
      const existing = getMappedId(key);
      if (existing && hasNode(existing))
        return { key, id: existing, present: true };
      const candidate = createId();
      const { winner } = await claimMapping(key, candidate);
      setMapping(key, winner);
      return { key, id: winner, present: hasNode(winner) };
    }),
  );
  const keymap = new Map(claims.map((c) => [c.key, c.id]));
  const toCreate = new Set(claims.filter((c) => !c.present).map((c) => c.key));
  if (toCreate.size > 0) resyncNodes();

  // Phase 2: build the synchronous steps (parents-first creates, then day moves).
  const createSteps: Array<() => void> = [];
  for (const key of plan.scaffoldKeys) {
    if (!toCreate.has(key)) continue;
    const id = keymap.get(key)!;
    const parentKey = parentScaffoldKey(key);
    const parentId = parentKey ? keymap.get(parentKey) : containerId;
    if (!parentId) continue; // parent claim failed -> skip (retry next touch)
    createSteps.push(() => {
      // Revalidate at apply time (finding 4): a resync between the async claims
      // and this synchronous batch may have already materialized the node under
      // `id` (its mapping now resolves), so re-inserting would duplicate it.
      if (hasNode(id)) return;
      insertScaffoldNode(parentId, key, scaffoldLabel(key), id);
    });
  }
  const moveSteps: Array<() => void> = [];
  for (const { nodeId, weekKey } of plan.days) {
    const weekId = keymap.get(weekKey);
    if (!weekId) continue;
    moveSteps.push(() => moveDaySorted(nodeId, weekId, containerId));
  }
  const steps = [...createSteps, ...moveSteps];
  if (steps.length === 0) return;

  // Estimate collection WRITES, not step count (finding 8a): every other sliced
  // consumer measures RESTORE_SLICE_OPS in writes (history.ts), and a sorted
  // create is ~2 writes (insert + follower repoint), a day move ~3 (old follower
  // + node + new follower). Counting steps would undercount and wrongly take the
  // synchronous burst path on a mid-size migration.
  const estimatedWrites = createSteps.length * 2 + moveSteps.length * 3;

  // One undo point: snapshot the whole pre-migration tree, then apply.
  const captureStep = () =>
    capture(buildTreeIndex(getLiveNodes()), containerId);
  if (estimatedWrites < RESTORE_SLICE_OPS) {
    runStructural(() => {
      captureStep();
      for (const step of steps) step();
    });
  } else {
    // Wire the modal progress (finding 8c): a big migration streams behind the
    // history-restore dialog instead of freezing a blank /today, exactly like
    // undo/redo + the big delete (setRestoreProgress).
    const all = [captureStep, ...steps];
    let applied = 0;
    setRestoreProgress({
      kind: "restoring",
      label: "Organizing",
      total: all.length,
      applied: 0,
    });
    try {
      await runStructuralSliced(all, () =>
        setRestoreProgress({
          kind: "restoring",
          label: "Organizing",
          total: all.length,
          applied: ++applied,
        }),
      );
    } finally {
      setRestoreProgress({ kind: "closed" });
    }
  }
  toast.success("Organized your daily notes by week");
}

/** In-flight NEW-day creates, keyed by date key (F1). A create's optimistic
 *  rows + mapping exist the instant its batch applies, but its DURABILITY isn't
 *  confirmed until the echo lands -- so a concurrent caller for the SAME key
 *  reading those optimistic rows would return a phantom id (the #233 defect,
 *  re-openable because quick-add borns with `trackNavigation:false` and
 *  `withDailyNavigation` is a counter, not a mutex). A same-key second caller
 *  JOINS the entry here instead of re-running the fast path. Only the CREATE
 *  path registers, so an already-durable day never touches this map. The map
 *  caches the RAW {@link NewDayResult} -- never a toast-translated chain -- so
 *  every joiner evaluates its OWN toast/rejection decision on the shared result
 *  (a baked-in side effect would inherit the ORIGINATOR's copy/suppression). */
const inFlightDays = new Map<string, Promise<NewDayResult>>();

/** The shared get-or-create body: readiness + claims + migration + heal-or-
 *  create, single-flighted per key. Returns the RAW {@link NewDayResult} and
 *  performs NO toasting -- callers ({@link getOrCreateDay}, the Seam-L
 *  `captureDestination.resolve`) each translate per their own surface. */
export async function getOrCreateDayResult(
  key: string,
  opts?: { seedEntryLine?: boolean; trackNavigation?: boolean },
): Promise<NewDayResult> {
  const run = async (): Promise<NewDayResult> => {
    // Single-flight join, checked FIRST (F1): while a same-key create is in
    // flight, the claims + `day.present` fast path below read the creator's
    // OPTIMISTIC rows (the claim already set the mapping, the batch already
    // applied locally) -- durability pending -- so they'd return a phantom via
    // healExistingDay without ever reaching the create path's check. The present
    // fast path cannot be trusted while a create is in flight; join it instead.
    // With nothing in flight, the genuinely-durable fast path runs untouched.
    const joined = inFlightDays.get(key);
    if (joined) return joined;
    // Freshest cross-device mappings before placement OR the migration plan
    // (finding 4): a cold load hasn't fetched the index yet, and remote-created
    // days' MAPPINGS aren't broadcast -- either leaves sorted insertion / the
    // migration working against a stale reverse map.
    await refreshDailyIndex();
    // Container + this day: independent per-key atomic claims, run concurrently
    // (finding 2/8a). The claim winner is authoritative; a loser reuses it.
    const [container, day] = await Promise.all([
      claimScaffoldNode(CONTAINER_KEY),
      claimScaffoldNode(key),
    ]);
    // Nest any legacy flat days before placing this one (issue #271) -- its own
    // inline batch (deliberate: the new day must land in the migrated scaffold).
    await ensureDailyMigrated(container.id);
    // An EXISTING day (pre-migration flat OR already nested): reuse it, heal a
    // blank title + optional seed, and DO NOT mint Y/M/W scaffold beside it --
    // placement is the migration's job (finding 3).
    if (day.present) {
      healExistingDay(day.id, key, opts?.seedEntryLine ?? false);
      return { id: day.id };
    }
    // Re-check at the create seam (F1): a caller that entered run() BEFORE this
    // create registered (the top check saw nothing) can land here after its own
    // claims -- join rather than double-create. Registered synchronously (no
    // await between the materializeNewDay call and the `set`), deleted in
    // `finally`. A joiner inherits this create's seed decision.
    const inFlight = inFlightDays.get(key);
    if (inFlight) return inFlight;
    const creating = materializeNewDay(
      container,
      day,
      key,
      opts?.seedEntryLine ?? false,
    );
    inFlightDays.set(key, creating);
    void creating.finally(() => {
      if (inFlightDays.get(key) === creating) inFlightDays.delete(key);
    });
    return creating;
  };
  // `trackNavigation: false` skips the shared nav-pending signal (ADR 0049): a
  // background quick-add born resolves today's note WITHOUT spinning the
  // unrelated header "Today" button, which is reserved for an actual navigation.
  return opts?.trackNavigation === false ? run() : withDailyNavigation(run);
}

/** Ensure the container + the day exist and return the day's node id (no nav).
 *  Reads the LIVE collection throughout (not a passed index) so the Today button,
 *  the `/` command, AND the Cmd+K virtual action (Seam J -- which has no
 *  `PluginContext`) all reuse the exact same get-or-create (ADR 0001).
 *  Async: it may round-trip the atomic claims before the node ids are settled.
 *  On a failed create THIS caller decides its own toast (F3): the cap skips the
 *  generic notice (the upgrade toast already fired), everything else shows the
 *  caller's `failureToast` copy -- per-caller even across an in-flight join. */
export async function getOrCreateDay(
  key: string,
  opts?: {
    seedEntryLine?: boolean;
    trackNavigation?: boolean;
    /** Copy for the generic "couldn't open" toast when the create fails for a
     *  NON-cap reason. Default: today's-note copy. */
    failureToast?: string;
  },
): Promise<string | null> {
  const result = await getOrCreateDayResult(key, opts);
  if (result.id !== null) return result.id;
  if (!isNodesLimitError(result.cause))
    toast.error(opts?.failureToast ?? "Couldn't open today's daily note");
  return null;
}

/** get-or-create the day, then navigate to it -- a date-chip click (a reference,
 *  seed-free; the Today button navigates the route with focus=last instead).
 *  `morph` (default true) picks the nav: a date chip is an element in the
 *  outgoing view, so it MORPHS into the new title (`ctx.nav.zoom`); the week
 *  strip's pill isn't -- its layoutId pill already IS the transition -- so it
 *  passes `morph: false` for a PLAIN swap (ADR 0054). */
export async function goToDate(
  key: string,
  ctx: PluginContext,
  opts?: { morph?: boolean },
): Promise<void> {
  const dayId = await getOrCreateDay(key, {
    failureToast: "Couldn't open that daily note",
  });
  if (!dayId) return; // getOrCreateDay owns the generic toast now (F3)
  if (opts?.morph === false) ctx.nav.open(dayId);
  else ctx.nav.zoom(dayId);
}
