// Daily Notes plugin (ADR 0001). Each calendar day gets a node; a header button
// jumps to today, creating it on first use. Built entirely on public seams plus
// two new ones this feature introduced:
//
//   - Seam F (header): the "Today" button (ADR 0002) -- node-less chrome.
//   - Protected nodes: the "Daily" container can't be deleted (ADR 0015).
//   - Seam F (row): the date badge on each day note.
//   - Seam A + B (ADR 0038): the `[[YYYY-MM-DD]]` date token -- a chip whose
//     click travels to that day's note (lazy get-or-create; a chip render
//     never touches the index). Grammar/parse live in src/data/date-links.ts.
//
// Identity lives in a side-collection (`daily-index.ts`), never on the `Node`
// schema or in text. Node creation is composed from the existing low-level
// `mutations.ts` primitives -- the same ones `appendChild` documents itself for
// ("seed code owns the wiring") -- NOT routed through `NodeCommands`, whose
// capture/pending-focus semantics are editor-edit concerns a get-or-create that
// navigates away doesn't want.

import { useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import {
  CalendarArrowDownIcon,
  CalendarDaysIcon,
  CalendarPlusIcon,
  Loader2Icon,
  SunIcon,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge, Button } from "@/plugins/kit";

import type { WidgetEl } from "../types";

import { setRestoreProgress } from "../../components/history-restore";
import { nodesCollection, resyncNodes } from "../../data/collection";
import {
  DATE_LINK_PATTERN,
  PROTECTED_SCAFFOLD_KINDS,
  dayKeyToScaffoldChain,
  monthLabel,
  parentScaffoldKey,
  parseDateLink,
  scaffoldKeyKind,
  scaffoldLabel,
  weekLabel,
  yearLabel,
} from "../../data/date-links";
import { isMirrorsEnabled } from "../../data/flags";
import { RESTORE_SLICE_OPS, capture, drop } from "../../data/history";
import {
  appendChild,
  insertChildAtStart,
  insertSibling,
  mirrorManyNodes,
  mirrorNode,
  moveManyNodes,
  moveNode,
  setText,
} from "../../data/mutations";
import { runStructural, runStructuralSliced } from "../../data/structural";
import { buildTreeIndex, childrenOf, createId } from "../../data/tree";
import {
  definePlugin,
  type NodeProtection,
  type PluginContext,
} from "../types";
import {
  CONTAINER_KEY,
  DAILY_CONTAINER_TEXT,
  claimMapping,
  formatDayBadge,
  formatDayRelative,
  formatDayText,
  getDailyRows,
  getKeyForNode,
  getMappedId,
  localDateKey,
  preloadDailyIndex,
  refreshDailyIndex,
  setMapping,
  subscribeDailyIndex,
  useScaffoldKey,
} from "./daily-index";
import { DateLinkChip } from "./date-chip";
import { useDailyNavigationPending, withDailyNavigation } from "./pending";
import {
  type DailyMigrationPlan,
  formatWeekRange,
  formatWeekRelative,
  inScaffoldScope,
  planDailyMigration,
  sortedInsertAfterId,
} from "./scaffold";

// --- get-or-create ----------------------------------------------------------

// The cascade is CLAIM-FIRST: when the local replica shows a scaffold/day node
// absent, mint a candidate id and run it through the atomic `claimMapping`. The
// claim winner id is authoritative; missing node rows are materialized locally
// under that id in ONE structural batch (ADR 0009) -- claims resolve up front and
// concurrently, then a single synchronous body materializes every missing level
// + the day + the optional seed. The fast path (today already in the local
// replica) stays synchronous-quick with no scaffold round-trip. See daily-index.ts.

function hasNode(id: string): boolean {
  return nodesCollection.toArray.some((n) => n.id === id);
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

/** The protection descriptor for a year / month / week scaffold node (issue
 *  #271, decision 6): the same four rules as the container, with the canonical
 *  name restored on blank. `noun` reads into the toast copy ("This week ..."). */
function scaffoldProtection(
  noun: "year" | "month" | "week",
  name: string,
): NodeProtection {
  return {
    reason: `This ${noun} groups your daily notes and can't be deleted.`,
    blankReason: `This daily ${noun} needs its name.`,
    taskReason: `A daily ${noun} can't be a to-do.`,
    completeReason: `A daily ${noun} can't be completed.`,
    canonicalText: name,
  };
}

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
  const index = buildTreeIndex(nodesCollection.toArray);
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
  const node = nodesCollection.toArray.find((n) => n.id === dayId);
  if (node && !node.text.trim()) setText(dayId, formatDayText(key));
  // Seeding is opt-in at the OPEN boundary (ADR 0041): only a write-intent
  // surface (/today, Today button, Cmd+K "Go to Today") asks for an empty line.
  // A reopened-but-emptied day re-seeds in its own isolated batch. No capture()
  // -- stays out of undo like day creation.
  if (seedEntryLine && !hasChildInLiveCollection(dayId)) {
    runStructural(() => appendChild(dayId, null, ""));
  }
}

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
): Promise<string | null> {
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
  runStructural(() => {
    // Container: appended at the end of the top level (special, not sorted).
    if (!hasNode(container.id)) {
      const tops = childrenOf(buildTreeIndex(nodesCollection.toArray), null);
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
  return hasNode(day.id) ? day.id : null;
}

/** Does `parentId` have any child in the LIVE nodes collection? Used for the
 *  reopen-seed check, which must not trust a possibly-stale tree index. */
function hasChildInLiveCollection(parentId: string): boolean {
  return nodesCollection.toArray.some((n) => n.parentId === parentId);
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
    buildTreeIndex(nodesCollection.toArray),
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
  const index = buildTreeIndex(nodesCollection.toArray);
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
    capture(buildTreeIndex(nodesCollection.toArray), containerId);
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

/** Ensure the container + the day exist and return the day's node id (no nav).
 *  Reads the LIVE collection throughout (not a passed index) so the Today button,
 *  the `/` command, AND the Cmd+K virtual action (Seam J -- which has no
 *  `PluginContext`) all reuse the exact same get-or-create (ADR 0001).
 *  Async: it may round-trip the atomic claims before the node ids are settled. */
async function getOrCreateDay(
  key: string,
  opts?: { seedEntryLine?: boolean; trackNavigation?: boolean },
): Promise<string | null> {
  const run = async () => {
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
      return day.id;
    }
    return materializeNewDay(container, day, key, opts?.seedEntryLine ?? false);
  };
  // `trackNavigation: false` skips the shared nav-pending signal (ADR 0049): a
  // background quick-add born resolves today's note WITHOUT spinning the
  // unrelated header "Today" button, which is reserved for an actual navigation.
  return opts?.trackNavigation === false ? run() : withDailyNavigation(run);
}

export { getOrCreateDay };

/** get-or-create the day, then zoom to it -- a date-chip click (a reference,
 *  seed-free; the Today button navigates the route with focus=last instead). */
async function goToDate(key: string, ctx: PluginContext): Promise<void> {
  const dayId = await getOrCreateDay(key);
  if (!dayId) {
    toast.error("Couldn't open that daily note");
    return;
  }
  ctx.nav.zoom(dayId);
}

// --- Seam A + B: the `[[YYYY-MM-DD]]` date token (ADR 0038) ------------------

// The atom: `source` is the verbatim token (what the caret math counts and
// copy reads back); `data-date-link` carries the day KEY (interior's first 10
// chars) for the Seam-B click handler. The core adds `data-src`/
// `contenteditable`. An atom but NOT folding: no caret reveal, backspace
// deletes the whole token.
function dateWidget(tok: string, key: string): WidgetEl {
  return {
    kind: "widget",
    source: tok,
    attrs: { "data-date-link": key },
  };
}

// --- header slot: the "Today" button ----------------------------------------

function TodayButton({ getCtx }: { getCtx: () => PluginContext }) {
  const pending = useDailyNavigationPending();
  const navigate = useNavigate();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      aria-busy={pending}
      data-daily-nav-pending={pending ? "" : undefined}
      onClick={() => {
        const ctx = getCtx();
        // The Today button is a write-intent surface (ADR 0041): seed an entry
        // line and route to the day with focus=last so the caret lands on it.
        // Unlike a date chip (which zooms via goToDate), this navigates the
        // route -- the on-load focus mechanism needs a pivotless navigation.
        ctx.run(
          Effect.promise(async () => {
            const dayId = await getOrCreateDay(localDateKey(), {
              seedEntryLine: true,
            });
            if (!dayId) {
              toast.error("Couldn't open today's daily note");
              return;
            }
            navigate({
              to: "/$nodeId",
              params: { nodeId: dayId },
              search: { focus: "last" },
            });
          }),
        );
      }}
    >
      {pending ? (
        <Loader2Icon className="animate-spin" />
      ) : (
        <CalendarDaysIcon />
      )}
      <span className="sr-only">Today&apos;s daily note</span>
    </Button>
  );
}

// --- slot: the date badge ---------------------------------------------------

// Rendered in two homes (Seam F): the list bullet (`placement="row"`) and the
// zoomed page title (`placement="title"`). The only visual difference is the
// vertical nudge -- the outline row top-aligns its children so the badge needs
// `mt-1` to land on the text baseline, while `.zoomed-title` is flex-centered
// so it needs none. Same size in both: a small pill reads as a label beside the
// big title, consistent with the row.
// One reactive read of the node's scaffold key, dispatched by kind (issue #271):
// a DAY renders the relative pill, a WEEK renders the date-range badge, and a
// year/month renders nothing (their node text -- "2026" / "July" -- is the
// label). Reading the key once here keeps the per-row hook count at one.
function ScaffoldBadge({
  nodeId,
  placement,
}: {
  nodeId: string;
  placement: "row" | "title";
}) {
  const key = useScaffoldKey(nodeId);
  if (!key) return null;
  switch (scaffoldKeyKind(key)) {
    case "day":
      return <DailyBadge dayKey={key} placement={placement} />;
    case "week":
      return <WeekBadge weekKey={key} placement={placement} />;
    default:
      return null;
  }
}

function DailyBadge({
  dayKey,
  placement,
}: {
  dayKey: string;
  placement: "row" | "title";
}) {
  const isToday = dayKey === localDateKey();
  return (
    <Badge
      variant={isToday ? "default" : "secondary"}
      className={cn([
        "shrink-0 border!",
        // Row vertical alignment is the shared `.outline-row [data-daily-date]`
        // rule (scales with reading size, ADR 0029); title keeps its own nudge.
        placement === "title" && "mt-2",
        isToday ? "border-transparent" : "border-border",
      ])}
      data-daily-date={dayKey}
      data-daily-today={isToday ? "" : undefined}
    >
      {isToday && <SunIcon className="shrink-0" />}
      {formatDayBadge(dayKey)}
    </Badge>
  );
}

// The week node's badge (Seam F, issue #271): the date range ("Jul 13 – 19")
// with a "This week" / "Last week" relative prefix. "Now" derives from
// localDateKey (local midnight), so it agrees with the day pill. Shares the day
// badge's `[data-daily-date]` optical-alignment rule via `data-daily-week`.
function WeekBadge({
  weekKey,
  placement,
}: {
  weekKey: string;
  placement: "row" | "title";
}) {
  const relative = formatWeekRelative(weekKey);
  const thisWeek = relative === "This week";
  const label = relative
    ? `${relative} · ${formatWeekRange(weekKey)}`
    : formatWeekRange(weekKey);
  return (
    <Badge
      variant={thisWeek ? "default" : "secondary"}
      className={cn([
        "shrink-0 border!",
        placement === "title" && "mt-2",
        thisWeek ? "border-transparent" : "border-border",
      ])}
      data-daily-week={weekKey}
      data-daily-this-week={thisWeek ? "" : undefined}
    >
      {label}
    </Badge>
  );
}

export default definePlugin({
  id: "daily",

  // Seam A: the `[[YYYY-MM-DD]]` date token (ADR 0038), rendered as a
  // badge-language chip (a BibleChip-class TSX atom -- ADR 0006).
  tokens: [
    {
      id: "date-link",
      pattern: DATE_LINK_PATTERN,
      // After node-links (5): both start `[[`, but the interiors are disjoint
      // by construction (date-shaped vs id-shaped), so the slot only needs to
      // be distinct. Before code (10) so a date pasted into a bullet wins over
      // a stray backtick span. NOT folding -- the chip never reveals raw
      // source on caret proximity; backspace deletes the whole token.
      precedence: 6,
      component: DateLinkChip,
      render: (tok) => {
        const parsed = parseDateLink(tok);
        // Regex proposes shape, the calendar disposes: `[[2026-13-45]]` falls
        // through to plain text, never a chip (the route-bible discipline).
        return parsed ? dateWidget(tok, parsed.key) : tok;
      },
    },
  ],

  // Seam B: a date chip travels to that day's note -- the Today-button
  // semantics (lazy get-or-create + zoom). This click is the ONLY place a
  // chip touches the daily index; rendering never mints (ADR 0038). Mousedown
  // blocks the editing caret (the chip lives inside the contentEditable).
  interactions: [
    {
      selector: "[data-date-link]",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        const key = el.dataset.dateLink;
        if (!key) return;
        e.preventDefault();
        e.stopPropagation();
        ctx.run(Effect.promise(() => goToDate(key, ctx)));
      },
    },
  ],

  // Seam F (header): jump to today, creating it on first use. Reads ctx lazily.
  headerSlots: [
    {
      id: "daily-today",
      render: (getCtx) => <TodayButton getCtx={getCtx} />,
    },
  ],

  // Seam F (row + title): the scaffold badge, between the bullet dot and the
  // text. A day note gets the relative pill, a week node the date range; a
  // year/month renders nothing (ScaffoldBadge returns null). Registered in BOTH
  // render paths so it shows on the list bullet AND the zoomed page title.
  slots: [
    {
      id: "daily-scaffold-badge",
      position: "row:before-text",
      render: (node) => <ScaffoldBadge nodeId={node.id} placement="row" />,
    },
    {
      id: "daily-scaffold-badge-title",
      position: "title:before-text",
      render: (node) => <ScaffoldBadge nodeId={node.id} placement="title" />,
    },
  ],

  // Seam C: a `/` command to move the focused node under today's note. Mirrors
  // the core `/move` completion (move-dialog.tsx): one undo step, append as
  // today's last child, then stay put + toast with a "Go" to jump there. Label
  // deliberately avoids "move" -- the menu substring-matches label+keywords, so
  // "Move to Today" would shadow the core `/move`. "/today" finds this; "/move"
  // stays the general mover.
  commands: [
    {
      id: "send-to-today",
      label: "Send to Today",
      description: "Move this node under today's daily note",
      icon: CalendarArrowDownIcon,
      keywords: ["today", "daily", "journal"],
      available: () => true,
      run: async (nodeId, ctx) => {
        const todayId = await getOrCreateDay(localDateKey());
        if (!todayId) {
          toast.error("Couldn't open today's daily note");
          return;
        }
        if (todayId === nodeId) return; // can't move today's note under itself
        const kids = childrenOf(ctx.tree, todayId);
        const after = kids.length ? kids[kids.length - 1]!.id : null;
        const moved = runStructural(() => {
          capture(ctx.tree, nodeId);
          return moveNode(ctx.tree, nodeId, todayId, after);
        });
        // No-op move (already last child of today) still captured an undo
        // point; drop it so Cmd+Z isn't a dead step and redo history survives.
        if (!moved) {
          drop();
          return;
        }
        toast.success("Moved to Today", {
          action: { label: "Go", onClick: () => ctx.nav.zoom(todayId) },
        });
      },
      // Node multi-selection (ADR 0018): move every selected root under today's
      // note in ONE batch + ONE navigation. Resolve today once (get-or-create),
      // drop today itself if it's in the selection, then append the run as
      // today's last children (moveManyNodes rebuilds the index per move so the
      // sibling chain stays intact). Capture against the LIVE tree -- AFTER the
      // day may have just been created -- so undo restores the moves without
      // deleting the new day note.
      runMany: async (ids, ctx) => {
        const todayId = await getOrCreateDay(localDateKey());
        if (!todayId) {
          toast.error("Couldn't open today's daily note");
          return;
        }
        const targets = ids.filter((id) => id !== todayId);
        if (targets.length === 0) return;
        const moved = runStructural(() => {
          capture(buildTreeIndex(nodesCollection.toArray), targets[0]!);
          return moveManyNodes(todayId, targets);
        });
        if (!moved) {
          drop();
          return;
        }
        toast.success(`Moved ${moved} to Today`, {
          action: { label: "Go", onClick: () => ctx.nav.zoom(todayId) },
        });
      },
    },

    // Seam C: the mirror sibling of "Send to Today" -- create a LIVE copy of the
    // node under today's note (ADR 0022) instead of moving it, so the same node
    // stays where it is AND appears in Today, editable from both. Hidden until
    // the mirrors flag is on. No picker: the destination is always today.
    {
      id: "mirror-to-today",
      label: "Mirror to Today",
      description: "Show a live copy under today's daily note",
      icon: CalendarPlusIcon,
      keywords: ["today", "daily", "mirror", "synced"],
      available: () => isMirrorsEnabled(),
      run: async (nodeId, ctx) => {
        const todayId = await getOrCreateDay(localDateKey());
        if (!todayId) {
          toast.error("Couldn't open today's daily note");
          return;
        }
        // Rebuild fresh: today may have just been created, so ctx.tree is stale
        // (no `after`, no cycle context). Capture AFTER, so undo removes the
        // mirror but keeps the new day note (mirrors the runMany path below).
        const index = buildTreeIndex(nodesCollection.toArray);
        const newId = runStructural(() => {
          capture(index, nodeId);
          return mirrorNode(index, nodeId, todayId);
        });
        if (!newId) {
          drop();
          toast.error("Can't mirror that into Today.");
          return;
        }
        toast.success("Mirrored to Today", {
          action: { label: "Go", onClick: () => ctx.nav.zoom(todayId) },
        });
      },
      // Node multi-selection (ADR 0018): mirror every selected root under today
      // in ONE batch. Captured against the LIVE tree AFTER the day exists, so
      // undo removes the mirrors without deleting the freshly created day note.
      runMany: async (ids, ctx) => {
        const todayId = await getOrCreateDay(localDateKey());
        if (!todayId) {
          toast.error("Couldn't open today's daily note");
          return;
        }
        const made = runStructural(() => {
          capture(buildTreeIndex(nodesCollection.toArray), ids[0]!);
          return mirrorManyNodes(todayId, ids);
        });
        if (!made) {
          drop();
          toast.error("Couldn't mirror those into Today.");
          return;
        }
        toast.success(`Mirrored ${made} to Today`, {
          action: { label: "Go", onClick: () => ctx.nav.zoom(todayId) },
        });
      },
    },
  ],

  // Protected nodes: the container AND every scaffold node (year / month / week)
  // can't be deleted -- removeNode cascades, so an unprotected week delete would
  // take its days (and everything written under them) with it (issue #271,
  // decision 6). Day notes stay deletable (they hold the user's own content).
  // Each descriptor carries the rejected-action toast copy and the canonical
  // name to restore if the row is blanked (a scaffold node can't be nameless).
  protects: (nodeId) => {
    const key = getKeyForNode(nodeId);
    if (!key) return false;
    const kind = scaffoldKeyKind(key);
    // Which kinds are protected is the shared source of truth (finding 10b): the
    // container + every calendar level, but never a day. The per-kind copy stays
    // here; the set decides protected-vs-not so the client and Worker can't drift.
    if (!kind || !PROTECTED_SCAFFOLD_KINDS.has(kind)) return false;
    switch (kind) {
      case "container":
        return {
          reason:
            "The Daily list can't be deleted. It holds all your daily notes.",
          blankReason: "The Daily list needs a name.",
          taskReason: "The Daily list can't be a to-do.",
          completeReason: "The Daily list can't be completed.",
          canonicalText: DAILY_CONTAINER_TEXT,
        };
      case "year":
        return scaffoldProtection("year", yearLabel(key));
      case "month":
        return scaffoldProtection("month", monthLabel(key));
      case "week":
        return scaffoldProtection("week", weekLabel(key));
      default:
        return false; // day notes + non-scaffold nodes stay editable/deletable
    }
  },

  // `getKeyForNode` reads the daily index, which loads async -- so a scaffold
  // node's lock must re-render when its `key -> nodeId` mapping resolves. Without
  // this the core's `useIsProtected` only re-evaluates on an unrelated re-render
  // (e.g. zoom), so the lock appears late.
  protectsChanged: subscribeDailyIndex,

  // Start the daily-index kv fetch at editor mount, so the date badges and the
  // container lock are (usually) resolvable by the time the outline snapshot
  // paints -- lazily it would only start at the first badge render, landing
  // after paint and shifting layout.
  preload: preloadDailyIndex,

  // Seam J: make day notes findable by their RELATIVE label in the Cmd+K
  // switcher and the /move picker, even though the node's text is the full date
  // ("Today"/"Yesterday"/"Tomorrow"/"Jun 23" from the id->date mapping) -- and
  // WEEK nodes by "This week"/"Last week" (+ their "Week 29" label), so Cmd+K
  // jumps to the current week (issue #271, decision 7). Matched (a second Fuse
  // key) but never highlighted -- the row still shows the node text.
  searchAliases: (node) => {
    const key = getKeyForNode(node.id);
    if (!key) return [];
    switch (scaffoldKeyKind(key)) {
      case "day":
        return [formatDayBadge(key)];
      case "week": {
        const relative = formatWeekRelative(key);
        return relative ? [relative, weekLabel(key)] : [weekLabel(key)];
      }
      default:
        return [];
    }
  },

  // Seam J: a parenthetical suffix on the picker row so a day note reads
  // "Tuesday, June 23, 2026 (Today)" and a week node "Week 29 (This week)" --
  // relative labels only (a date/range would just echo the text/badge).
  // Display-only; the aliases above are what actually match.
  searchAnnotation: (node) => {
    const key = getKeyForNode(node.id);
    if (!key) return null;
    switch (scaffoldKeyKind(key)) {
      case "day":
        return formatDayRelative(key);
      case "week":
        return formatWeekRelative(key);
      default:
        return null;
    }
  },

  // Seam (ADR 0049): quick-add captures default to today's note. LAZY -- the
  // label is known up front (the chip reads "Today" the instant the overlay
  // opens), but `resolve` -- which get-or-creates the day SEED-FREE (like Send
  // to Today, ADR 0041) -- runs only at born-on-first-keystroke, so an abandoned
  // open never mints today's note. Core resolves this without importing daily.
  captureDestination: () => ({
    label: "Today",
    resolve: () =>
      getOrCreateDay(localDateKey(), {
        trackNavigation: false,
      }),
  }),

  // Seam J: a VIRTUAL switcher row that appears only when today's note does NOT
  // exist yet (when it does, the alias above surfaces the real node -- no dup).
  // Picking it creates the note + container, then navigates. This is the "search
  // today even if it isn't there" half (ADR 0001).
  searchActions: (query, ctx) => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !"today".startsWith(q)) return [];
    const key = localDateKey();
    const existing = getMappedId(key);
    if (existing && ctx.index.byId.has(existing)) return [];
    return [
      {
        key: "daily-go-today",
        label: "Go to Today",
        hint: "Creates today's daily note",
        icon: CalendarDaysIcon,
        // "Go to Today" is a write-intent surface (ADR 0041): seed an entry
        // line and land the caret on it via focus=last.
        run: () =>
          void getOrCreateDay(key, { seedEntryLine: true })
            .then((id) => {
              if (id) ctx.goTo(id, { focus: "last" });
              else toast.error("Couldn't open today's daily note");
            })
            .catch(() => toast.error("Couldn't open today's daily note")),
      },
    ];
  },
});
