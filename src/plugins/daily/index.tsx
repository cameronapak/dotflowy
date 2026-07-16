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

import {
  nodesCollection,
  resyncNodes,
  waitForNode,
} from "../../data/collection";
import {
  DATE_LINK_PATTERN,
  dayKeyToWeekKey,
  monthKeyToYearKey,
  monthLabel,
  parentScaffoldKey,
  parseDateLink,
  scaffoldKeyKind,
  weekKeyToMonthKey,
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
import {
  buildTreeIndex,
  childrenOf,
  createId,
  type TreeIndex,
} from "../../data/tree";
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
  getContainerId,
  getDayId,
  getKeyForNode,
  getMappedId,
  localDateKey,
  preloadDailyIndex,
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
  planDailyMigration,
  sortedInsertAfterId,
} from "./scaffold";

// --- get-or-create ----------------------------------------------------------

// Both get-or-creates are CLAIM-FIRST: when the local replica shows the
// container/day absent, mint a candidate id and run it through the atomic
// `claimMapping`. The claim winner id is authoritative; if the node row is
// still missing after a resync/wait (orphaned kv mapping), materialize it
// locally under that id. The fast path (already in the local replica) stays
// synchronous-quick with no network round-trip. See daily-index.ts.

function hasNode(id: string): boolean {
  return nodesCollection.toArray.some((n) => n.id === id);
}

/** Wait for a remote replica when we lost the claim; otherwise materialize now. */
async function ensureNodeExists(
  nodeId: string,
  materialize: () => void,
  awaitRemote: boolean,
): Promise<boolean> {
  if (hasNode(nodeId)) return true;
  if (awaitRemote) {
    resyncNodes();
    await waitForNode(nodeId, 1500).catch(() => {});
    if (hasNode(nodeId)) return true;
  }
  materialize();
  return hasNode(nodeId);
}

/**
 * The single "Daily" container, created lazily at the end of the top level.
 * Atomic-claim guarded so two devices first-using daily can't each mint one.
 */
async function ensureContainer(index: TreeIndex): Promise<string | null> {
  const existing = getContainerId();
  if (existing && index.byId.has(existing)) return existing;
  const candidate = createId();
  const { winner, won } = await claimMapping(CONTAINER_KEY, candidate);
  const tops = childrenOf(index, null);
  const after = tops.length ? tops[tops.length - 1]!.id : null;
  const ok = await ensureNodeExists(
    winner,
    () =>
      runStructural(() =>
        appendChild(null, after, DAILY_CONTAINER_TEXT, winner),
      ),
    !won,
  );
  setMapping(CONTAINER_KEY, winner);
  return ok ? winner : null;
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

/** The display label for a scaffold node's text: "2026" / "July" / "Week 29".
 *  Falls back to the raw key for a non-scaffold key (defensive). */
function scaffoldLabel(key: string): string {
  switch (scaffoldKeyKind(key)) {
    case "year":
      return yearLabel(key);
    case "month":
      return monthLabel(key);
    case "week":
      return weekLabel(key);
    default:
      return key;
  }
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

/**
 * Get-or-create ONE scaffold node (year / month / week) under `parentNodeId`,
 * claim-first and idempotent like the container/day (two devices can't each mint
 * one). Returns the authoritative node id, or null on a claim+materialize
 * failure. The label seeds the node's text; identity is the daily-index key.
 */
async function ensureScaffoldNode(
  key: string,
  parentNodeId: string,
): Promise<string | null> {
  const existing = getMappedId(key);
  if (existing && hasNode(existing)) return existing;
  const candidate = createId();
  const { winner, won } = await claimMapping(key, candidate);
  const ok = await ensureNodeExists(
    winner,
    () =>
      runStructural(() =>
        insertScaffoldNode(parentNodeId, key, scaffoldLabel(key), winner),
      ),
    !won,
  );
  setMapping(key, winner);
  return ok ? winner : null;
}

/**
 * Ensure the year > month > week scaffold for `dayKey` exists under the
 * container, returning the WEEK node id the day should nest under (decision 5,
 * lazy + seed-free -- each level is minted only when the first day in it is
 * created). The Thursday rule owns the straddle: `weekKeyToMonthKey` /
 * `monthKeyToYearKey` decide the owning month and year. A non-calendar key falls
 * back to the container itself (defensive; callers pass valid day keys).
 */
async function ensureDayParent(
  dayKey: string,
  containerId: string,
): Promise<string | null> {
  const weekKey = dayKeyToWeekKey(dayKey);
  const monthKey = weekKey ? weekKeyToMonthKey(weekKey) : null;
  const yearKey = monthKey ? monthKeyToYearKey(monthKey) : null;
  if (!weekKey || !monthKey || !yearKey) return containerId;
  const yearId = await ensureScaffoldNode(yearKey, containerId);
  if (!yearId) return null;
  const monthId = await ensureScaffoldNode(monthKey, yearId);
  if (!monthId) return null;
  return ensureScaffoldNode(weekKey, monthId);
}

/**
 * The note for `key`, created at its chronological slot under its WEEK
 * (`parentId`) if missing (decision 4, ascending -- replacing the old
 * newest-first head insertion). Text seeds to the full date; the badge shows the
 * relative label. The atomic claim makes "create today" idempotent across
 * devices: a loser reuses the winner's node instead of minting a duplicate.
 */
async function ensureDay(
  key: string,
  parentId: string,
  index: TreeIndex,
  seedEntryLine: boolean,
): Promise<string | null> {
  const existing = getDayId(key);
  if (existing && index.byId.has(existing)) {
    if (!index.byId.get(existing)!.text.trim()) {
      setText(existing, formatDayText(key));
    }
    // Seeding is opt-in at the OPEN boundary (ADR 0041): only a write-intent
    // surface (/today, Today button, Cmd+K "Go to Today") asks for an empty
    // line to type into -- reference surfaces (Send/Mirror-to-Today, MCP) never
    // do. A reopened-but-emptied day re-seeds in its own isolated batch. Check
    // the LIVE collection, not the passed `index`, which can predate a
    // just-fired seed. No capture() -- stays out of undo like day creation.
    if (seedEntryLine && !hasChildInLiveCollection(existing)) {
      runStructural(() => appendChild(existing, null, ""));
    }
    return existing;
  }
  const candidate = createId();
  const { winner, won } = await claimMapping(key, candidate);
  const ok = await ensureNodeExists(
    winner,
    () =>
      runStructural(() => {
        insertScaffoldNode(parentId, key, formatDayText(key), winner);
        // Fresh day: when a write-intent surface asked, seed the entry line in
        // the SAME batch as the day node (correct-by-construction, no sibling
        // fan). Otherwise the day is a bare title-only note.
        if (seedEntryLine) appendChild(winner, null, "");
      }),
    !won,
  );
  setMapping(key, winner);
  return ok ? winner : null;
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

/** Run the migration ONCE per session if any legacy flat day exists. Cheap when
 *  not needed (a filter over live nodes on daily interactions only), so it's
 *  safe to call on every get-or-create; the flat scan is the guard. */
async function ensureDailyMigrated(containerId: string): Promise<void> {
  if (dailyMigration) return dailyMigration;
  const plan = planDailyMigration(
    buildTreeIndex(nodesCollection.toArray),
    containerId,
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
 *  placement is a harmless no-op. Runs inside the migration's `runStructural`. */
function moveDaySorted(dayNodeId: string, weekId: string): void {
  const index = buildTreeIndex(nodesCollection.toArray);
  const dayKey = getKeyForNode(dayNodeId);
  if (!dayKey) return;
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
  // Phase 1: claim ids for every needed scaffold key, recording which must be
  // materialized (this device won and the node isn't present yet).
  const keymap = new Map<string, string>();
  const toCreate = new Set<string>();
  for (const key of plan.scaffoldKeys) {
    const existing = getMappedId(key);
    if (existing && hasNode(existing)) {
      keymap.set(key, existing);
      continue;
    }
    const candidate = createId();
    const { winner, won } = await claimMapping(key, candidate);
    setMapping(key, winner);
    keymap.set(key, winner);
    if (!hasNode(winner)) {
      if (!won) {
        resyncNodes();
        await waitForNode(winner, 1500).catch(() => {});
      }
      if (!hasNode(winner)) toCreate.add(key);
    }
  }

  // Phase 2: build the synchronous steps (parents-first creates, then day moves).
  const steps: Array<() => void> = [];
  for (const key of plan.scaffoldKeys) {
    if (!toCreate.has(key)) continue;
    const id = keymap.get(key)!;
    const parentKey = parentScaffoldKey(key);
    const parentId = parentKey ? keymap.get(parentKey) : containerId;
    if (!parentId) continue; // parent claim failed -> skip (retry next touch)
    steps.push(() => insertScaffoldNode(parentId, key, scaffoldLabel(key), id));
  }
  for (const { nodeId, weekKey } of plan.days) {
    const weekId = keymap.get(weekKey);
    if (!weekId) continue;
    steps.push(() => moveDaySorted(nodeId, weekId));
  }
  if (steps.length === 0) return;

  // One undo point: snapshot the whole pre-migration tree, then apply.
  const captureStep = () =>
    capture(buildTreeIndex(nodesCollection.toArray), containerId);
  if (steps.length < RESTORE_SLICE_OPS) {
    runStructural(() => {
      captureStep();
      for (const step of steps) step();
    });
  } else {
    await runStructuralSliced([captureStep, ...steps]);
  }
  toast.success("Organized your daily notes by week");
}

/** Ensure the container + the day exist and return the day's node id (no nav).
 *  Takes just the tree index (not a `PluginContext`) so the Today button, the
 *  `/` command, AND the Cmd+K virtual action (Seam J -- which has no
 *  `PluginContext`) all reuse the exact same get-or-create (ADR 0001).
 *  Async: it may round-trip the atomic claim before the node id is settled. */
async function getOrCreateDay(
  key: string,
  index: TreeIndex,
  opts?: { seedEntryLine?: boolean; trackNavigation?: boolean },
): Promise<string | null> {
  const run = async () => {
    const containerId = await ensureContainer(index);
    if (!containerId) return null;
    // Nest any legacy flat days before placing this one (issue #271) -- so the
    // new day lands in the migrated scaffold, not beside a half-migrated shape.
    await ensureDailyMigrated(containerId);
    const parentId = await ensureDayParent(key, containerId);
    if (!parentId) return null;
    return ensureDay(key, parentId, index, opts?.seedEntryLine ?? false);
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
  const dayId = await getOrCreateDay(key, ctx.tree);
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
            const dayId = await getOrCreateDay(localDateKey(), ctx.tree, {
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
        const todayId = await getOrCreateDay(localDateKey(), ctx.tree);
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
        const todayId = await getOrCreateDay(localDateKey(), ctx.tree);
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
        const todayId = await getOrCreateDay(localDateKey(), ctx.tree);
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
        const todayId = await getOrCreateDay(localDateKey(), ctx.tree);
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
    switch (scaffoldKeyKind(key)) {
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
      getOrCreateDay(localDateKey(), buildTreeIndex(nodesCollection.toArray), {
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
    const existing = getDayId(key);
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
          void getOrCreateDay(key, ctx.index, { seedEntryLine: true })
            .then((id) => {
              if (id) ctx.goTo(id, { focus: "last" });
              else toast.error("Couldn't open today's daily note");
            })
            .catch(() => toast.error("Couldn't open today's daily note")),
      },
    ];
  },
});
