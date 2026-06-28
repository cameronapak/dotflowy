// Daily Notes plugin (ADR 0019). Each calendar day gets a node; a header button
// jumps to today, creating it on first use. Built entirely on public seams plus
// two new ones this feature introduced:
//
//   - Seam F (header): the "Today" button (ADR 0020) -- node-less chrome.
//   - Protected nodes: the "Daily" container can't be deleted (ADR 0015).
//   - Seam F (row): the date badge on each day note.
//
// Identity lives in a side-collection (`daily-index.ts`), never on the `Node`
// schema or in text. Node creation is composed from the existing low-level
// `mutations.ts` primitives -- the same ones `appendChild` documents itself for
// ("seed code owns the wiring") -- NOT routed through `NodeCommands`, whose
// capture/pending-focus semantics are editor-edit concerns a get-or-create that
// navigates away doesn't want.

import {
  CalendarArrowDownIcon,
  CalendarDaysIcon,
  Loader2Icon,
  SunIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { definePlugin, type PluginContext } from "../types";
import { capture, drop } from "../../data/history";
import {
  appendChild,
  insertChildAtStart,
  moveNode,
  setText,
} from "../../data/mutations";
import { runStructural } from "../../data/structural";
import {
  nodesCollection,
  resyncNodes,
  waitForNode,
} from "../../data/collection";
import { childrenOf, createId, type TreeIndex } from "../../data/tree";
import {
  CONTAINER_KEY,
  DAILY_CONTAINER_TEXT,
  claimMapping,
  formatDayBadge,
  formatDayRelative,
  formatDayText,
  getContainerId,
  getDayId,
  getDayKey,
  isContainerNode,
  localDateKey,
  setMapping,
  subscribeDailyIndex,
  useDailyDate,
} from "./daily-index";
import { useDailyNavigationPending, withDailyNavigation } from "./pending";
import { cn } from "@/lib/utils";

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

/**
 * The note for `key`, created as the FIRST child of the container (newest day
 * on top) if missing. Text seeds to the full date; the badge shows the relative
 * label. The atomic claim makes "create today" idempotent across devices: a
 * loser reuses the winner's node instead of minting a duplicate. v1 caveat:
 * creating an out-of-order past day (via a future picker) still lands on top --
 * acceptable until the picker ships its own ordering.
 */
async function ensureDay(
  key: string,
  containerId: string,
  index: TreeIndex,
): Promise<string | null> {
  const existing = getDayId(key);
  if (existing && index.byId.has(existing)) {
    if (!index.byId.get(existing)!.text.trim()) {
      setText(existing, formatDayText(key));
    }
    return existing;
  }
  const candidate = createId();
  const { winner, won } = await claimMapping(key, candidate);
  const ok = await ensureNodeExists(
    winner,
    () =>
      runStructural(() =>
        insertChildAtStart(
          index,
          containerId,
          false,
          formatDayText(key),
          winner,
        ),
      ),
    !won,
  );
  setMapping(key, winner);
  return ok ? winner : null;
}

/** Ensure the container + the day exist and return the day's node id (no nav).
 *  Takes just the tree index (not a `PluginContext`) so the Today button, the
 *  `/` command, AND the Cmd+K virtual action (Seam J -- which has no
 *  `PluginContext`) all reuse the exact same get-or-create (ADR 0019/0022).
 *  Async: it may round-trip the atomic claim before the node id is settled. */
async function getOrCreateDay(
  key: string,
  index: TreeIndex,
): Promise<string | null> {
  return withDailyNavigation(async () => {
    const containerId = await ensureContainer(index);
    if (!containerId) return null;
    return ensureDay(key, containerId, index);
  });
}

/** get-or-create the day, then zoom to it (the Today button + future picker). */
async function goToDate(key: string, ctx: PluginContext): Promise<void> {
  const dayId = await getOrCreateDay(key, ctx.tree);
  if (!dayId) {
    toast.error("Couldn't open today's daily note");
    return;
  }
  ctx.nav.zoom(dayId);
}

// --- header slot: the "Today" button ----------------------------------------

function TodayButton({ getCtx }: { getCtx: () => PluginContext }) {
  const pending = useDailyNavigationPending();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      aria-busy={pending}
      data-daily-nav-pending={pending ? "" : undefined}
      onClick={() => void goToDate(localDateKey(), getCtx())}
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

// --- row slot: the date badge -----------------------------------------------

function DailyBadge({ nodeId }: { nodeId: string }) {
  const key = useDailyDate(nodeId);
  if (!key) return null;
  const isToday = key === localDateKey();
  return (
    <Badge
      variant={isToday ? "default" : "secondary"}
      className={cn([
        "shrink-0 mt-1 border!",
        isToday ? "border-transparent" : "border-border",
      ])}
      data-daily-date={key}
      data-daily-today={isToday ? "" : undefined}
    >
      {isToday && <SunIcon className="shrink-0" />}
      {formatDayBadge(key)}
    </Badge>
  );
}

export default definePlugin({
  id: "daily",

  // Seam F (header): jump to today, creating it on first use. Reads ctx lazily.
  headerSlots: [
    {
      id: "daily-today",
      render: (getCtx) => <TodayButton getCtx={getCtx} />,
    },
  ],

  // Seam F (row): the relative date pill, between the bullet dot and the text.
  // Renders only on a day note (useDailyDate returns null otherwise).
  slots: [
    {
      id: "daily-date-badge",
      position: "row:before-text",
      render: (node) => <DailyBadge nodeId={node.id} />,
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
    },
  ],

  // Protected nodes: the container can't be deleted -- it guards every day note
  // and everything written under them (removeNode cascades the subtree). The
  // descriptor carries the rejected-delete toast copy and the name to restore if
  // the row is blanked (it can't be left nameless).
  protects: (nodeId) =>
    isContainerNode(nodeId)
      ? {
          reason:
            "The Daily list can't be deleted. It holds all your daily notes.",
          blankReason: "The Daily list needs a name.",
          taskReason: "The Daily list can't be a to-do.",
          completeReason: "The Daily list can't be completed.",
          canonicalText: DAILY_CONTAINER_TEXT,
        }
      : false,

  // `isContainerNode` reads the daily index, which loads async -- so the
  // container's lock must re-render when the `container -> nodeId` mapping
  // resolves. Without this the core's `useIsProtected` only re-evaluates on an
  // unrelated re-render (e.g. zoom), so the lock appears late.
  protectsChanged: subscribeDailyIndex,

  // Seam J: make day notes findable by their RELATIVE label in the Cmd+K
  // switcher and the /move picker, even though the node's text is the full date.
  // Matched (a second Fuse key) but never highlighted -- the row still shows the
  // date text. "Today"/"Yesterday"/"Tomorrow"/"Jun 23" from the id->date mapping.
  searchAliases: (node) => {
    const key = getDayKey(node.id);
    return key ? [formatDayBadge(key)] : [];
  },

  // Seam J: a parenthetical suffix on the picker row so a day note reads
  // "Tuesday, June 23, 2026 (Today)" -- relative labels only (a date would just
  // echo the text). Display-only; the alias above is what actually matches.
  searchAnnotation: (node) => {
    const key = getDayKey(node.id);
    return key ? formatDayRelative(key) : null;
  },

  // Seam J: a VIRTUAL switcher row that appears only when today's note does NOT
  // exist yet (when it does, the alias above surfaces the real node -- no dup).
  // Picking it creates the note + container, then navigates. This is the "search
  // today even if it isn't there" half (ADR 0022).
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
        run: () =>
          void getOrCreateDay(key, ctx.index).then((id) => {
            if (id) ctx.goTo(id);
            else toast.error("Couldn't open today's daily note");
          }),
      },
    ];
  },
});
