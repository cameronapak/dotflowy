// Daily Notes plugin (ADR 0001). Each calendar day gets a node; a header button
// jumps to today, creating it on first use. Built entirely on public seams plus
// two new ones this feature introduced:
//
//   - Seam F (header): the "Today" button (ADR 0002) -- node-less chrome.
//   - Seam F (subheader): the week calendar strip (ADR 0054) -- day-to-day
//     navigation, shown only when zoomed on a day note.
//   - Protected nodes: the "Daily" container can't be deleted (ADR 0015).
//   - Seam F (row): the date badge on each day note.
//   - Seam A + B (ADR 0038): the `[[YYYY-MM-DD]]` date token -- a chip whose
//     click travels to that day's note (lazy get-or-create; a chip render
//     never touches the index). Grammar/parse live in src/data/date-links.ts.
//
// Identity lives in a side-collection (`daily-index.ts`), never on the `Node`
// schema or in text. The get-or-create engine (claims, cascade, migration) lives
// in `get-or-create.ts` so the week-calendar strip can reuse `goToDate` without
// an import cycle; it composes the low-level `mutations.ts` primitives directly
// -- NOT routed through `NodeCommands`, whose capture/pending-focus semantics are
// editor-edit concerns a get-or-create that navigates away doesn't want.

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

import { nodesCollection } from "../../data/collection";
import {
  DATE_LINK_PATTERN,
  PROTECTED_SCAFFOLD_KINDS,
  monthLabel,
  parseDateLink,
  scaffoldKeyKind,
  weekLabel,
  yearLabel,
} from "../../data/date-links";
import { isMirrorsEnabled } from "../../data/flags";
import { capture, drop } from "../../data/history";
import {
  mirrorManyNodes,
  mirrorNode,
  moveManyNodes,
} from "../../data/mutations";
import { isNodesLimitError } from "../../data/nodes-client-effect";
import { runStructural } from "../../data/structural";
import { buildTreeIndex } from "../../data/tree";
import {
  definePlugin,
  type NodeProtection,
  type PluginContext,
} from "../types";
import {
  DAILY_CONTAINER_TEXT,
  formatDayBadge,
  formatDayRelative,
  getKeyForNode,
  getMappedId,
  localDateKey,
  preloadDailyIndex,
  subscribeDailyIndex,
  useScaffoldKey,
} from "./daily-index";
import { DateLinkChip } from "./date-chip";
import {
  getOrCreateDay,
  getOrCreateDayResult,
  goToDate,
} from "./get-or-create";
import { useDailyNavigationPending } from "./pending";
import { formatWeekRange, formatWeekRelative } from "./scaffold";
import { WeekCalendar } from "./week-calendar";

// `getOrCreateDay` is re-exported for the `/today` route (routes/today.tsx),
// which resolves the day without navigating through a PluginContext.
export { getOrCreateDay };

// --- scaffold protection (issue #271) ---------------------------------------
//
// The get-or-create engine (get-or-create.ts, ADR 0054 extraction) mints the
// Daily > Y > M > W > D scaffold; this file keeps only the protection descriptor
// its `protects` seam reads.

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
            if (!dayId) return; // getOrCreateDay owns the generic toast now (F3)
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

  // Seam F (subheader): the week calendar strip (ADR 0054). Renders ONLY when
  // the zoom root reverse-maps to a `YYYY-MM-DD` day key; null everywhere else,
  // so the subheader band collapses on non-day pages. The strip resolves the
  // route reactively itself -- `getCtx` is used only at event time (the pill's
  // seed-free `goToDate`).
  subheaderSlots: [
    {
      id: "daily-week-calendar",
      render: (getCtx) => <WeekCalendar getCtx={getCtx} />,
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
        if (!todayId) return; // getOrCreateDay owns the generic toast now (F3)
        if (todayId === nodeId) return; // can't move today's note under itself
        // Reuse moveManyNodes (F5): it rebuilds the index per move and appends
        // as today's last child -- identical to the old hand-rolled block and the
        // runMany twin below. Capture the FRESH index (today may have just been
        // created), so undo restores the move without deleting the new day note.
        const moved = runStructural(() => {
          capture(buildTreeIndex(nodesCollection.toArray), nodeId);
          return moveManyNodes(todayId, [nodeId]);
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
        if (!todayId) return; // getOrCreateDay owns the generic toast now (F3)
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
        if (!todayId) return; // getOrCreateDay owns the generic toast now (F3)
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
        if (!todayId) return; // getOrCreateDay owns the generic toast now (F3)
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
    // REJECT on a failed create rather than returning null (F2): null is the
    // Seam-L value for "top level", so a swallowed failure would silently misfile
    // the capture at the outline root. Consumes the RAW result (no daily toast --
    // quick-add's startBorn owns the failure toast + keeps the draft, ADR 0049)
    // and rethrows the REAL NodesLimitError on a cap hit, so quick-add can skip
    // its generic toast (the upgrade one already fired) via the shared
    // data-layer `isNodesLimitError` -- no core-imports-daily leak.
    resolve: async () => {
      const result = await getOrCreateDayResult(localDateKey(), {
        trackNavigation: false,
      });
      if (result.id !== null) return result.id;
      if (isNodesLimitError(result.cause)) throw result.cause;
      throw new Error("daily: couldn't open today's note for quick-add");
    },
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
            // getOrCreateDay owns the generic failure toast now (F3); this only
            // navigates on success. The catch is defensive (a synchronous body
            // throw), mutually exclusive with the internal toast, so no double.
            .then((id) => {
              if (id) ctx.goTo(id, { focus: "last" });
            })
            .catch(() => toast.error("Couldn't open today's daily note")),
      },
    ];
  },
});
