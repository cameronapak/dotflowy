// The Day stream (ADR 0070): a zoomed day note continues into the days before
// and after it. This file is the Daily plugin's side of Seam N -- what a section
// is (a calendar day), when it is empty, and how one is created on its first
// keystroke. Core owns the list, scroll, and caret (src/data/view-stream.ts).

import type { ViewStream } from "../types";

import {
  addDays,
  dayKeyToUtc,
  formatDateFull,
  localDateKey,
  parentScaffoldKey,
  scaffoldKeyKind,
} from "../../data/date-links";
import { getEditorFeatures } from "../../data/editor-features";
import { getLiveNodes } from "../../data/live-nodes";
import { appendChild } from "../../data/mutations";
import { runStructural } from "../../data/structural";
import { buildTreeIndex, childrenOf, type TreeIndex } from "../../data/tree";
import {
  formatDayBadge,
  formatDayRelative,
  formatDayText,
  getDailyRows,
  getKeyForNode,
  getMappedId,
} from "./daily-index";
import { getOrCreateDay } from "./get-or-create";

/** How far the stream reaches past the outermost day with a note (or today,
 *  or the anchor). Enough to scroll into a quiet stretch and to plan ahead,
 *  without an endless run of empty pages. */
const PAST_REACH = 30;
const FUTURE_REACH = 60;

const DAY_MS = 86_400_000;

/** Whole days from `a` to `b` (positive when `b` is later). */
function dayDiff(a: string, b: string): number {
  const da = dayKeyToUtc(a);
  const db = dayKeyToUtc(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / DAY_MS);
}

/** An Empty day (CONTEXT.md): nothing written. A day whose only children are
 *  blank leaves, like a seeded entry line nobody typed in, counts as empty. */
export function isDayEmpty(index: TreeIndex, dayId: string): boolean {
  return childrenOf(index, dayId).every(
    (child) =>
      child.text.trim() === "" &&
      (index.childrenByParent.get(child.id)?.length ?? 0) === 0,
  );
}

/** The earliest and latest day keys with a mapped note. */
function mappedDayRange() {
  let first: string | null = null;
  let last: string | null = null;
  for (const row of getDailyRows()) {
    if (scaffoldKeyKind(row.key) !== "day") continue;
    if (first === null || row.key < first) first = row.key;
    if (last === null || row.key > last) last = row.key;
  }
  return { first, last };
}

function minKey(...keys: (string | null)[]): string {
  return keys.filter((k): k is string => k !== null).sort()[0]!;
}
function maxKey(...keys: (string | null)[]): string {
  const sorted = keys.filter((k): k is string => k !== null).sort();
  return sorted[sorted.length - 1]!;
}

function createDayStream(
  anchor: string,
  emptyMode: ViewStream["emptyMode"],
  today: string,
): ViewStream {
  // The daily index can drop rows for a moment while a claim re-syncs it.
  // Remember each day's node, and never narrow the bounds, so that gap does not
  // turn written days into placeholders or clip loaded sections. buildStream
  // still checks the remembered node exists in the tree.
  const known = new Map<string, string>();
  const resolve = (key: string): string | null => {
    const id = getMappedId(key);
    if (id) {
      known.set(key, id);
      return id;
    }
    return known.get(key) ?? null;
  };
  let reach = { first: anchor, last: anchor };
  // Bounds are read per call: a day created while scrolling widens them.
  const bounds = () => {
    const { first, last } = mappedDayRange();
    reach = {
      first: minKey(first, reach.first, today),
      last: maxKey(last, reach.last, today),
    };
    return {
      first: addDays(reach.first, -PAST_REACH),
      last: addDays(reach.last, FUTURE_REACH),
    };
  };
  return {
    anchor,
    emptyMode,
    keys(before, after) {
      const { first, last } = bounds();
      const start = Math.max(-before, dayDiff(anchor, first));
      const end = Math.min(after, dayDiff(anchor, last));
      const keys: string[] = [];
      for (let i = start; i <= end; i++) keys.push(addDays(anchor, i));
      return { keys, atStart: start > -before, atEnd: end < after };
    },
    offsetOf(key) {
      if (scaffoldKeyKind(key) !== "day") return null;
      // A day past the bounds is not a section: the caller navigates there
      // instead, which anchors a new stream on it.
      const { first, last } = bounds();
      if (key < first || key > last) return null;
      return dayDiff(anchor, key);
    },
    resolve,
    isEmpty(key, index) {
      const id = resolve(key);
      return id === null || !index.byId.has(id) || isDayEmpty(index, id);
    },
    pinned: (key) => key === anchor || key === today,
    placeholderTitle: formatDayText,
    badge: (key) => formatDayRelative(key, today),
    foldLabel(keys) {
      const first = keys[0]!;
      const last = keys[keys.length - 1]!;
      const [a, b] = first < last ? [first, last] : [last, first];
      if (keys.length === 1) return `${formatDateFull(a)}, empty`;
      return `${formatDayBadge(a, "")} - ${formatDayBadge(b, "")}, ${keys.length} empty days`;
    },
    trailFor(key) {
      // The deepest scaffold that exists: week, then month, year, container.
      let k = parentScaffoldKey(key);
      while (k !== null) {
        const id = getMappedId(k);
        if (id) return id;
        k = parentScaffoldKey(k);
      }
      return getMappedId("container");
    },
    async create(key) {
      const id = await getOrCreateDay(key, {
        seedEntryLine: true,
        failureToast: "Couldn't create that daily note",
      });
      if (!id) return null;
      const index = buildTreeIndex(getLiveNodes());
      const kids = childrenOf(index, id);
      const last = kids[kids.length - 1];
      if (last && last.text === "" && !index.childrenByParent.has(last.id))
        return { id, entryId: last.id };
      // Someone wrote here first: start a fresh line at the end.
      const entryId = runStructural(() => appendChild(id, last?.id ?? null));
      return entryId ? { id, entryId } : null;
    },
  };
}

let cached: { rootId: string; stream: ViewStream; sig: string } | null = null;

/** Seam N: the Day stream for a zoomed day note, or null when the root is not
 *  a day or the Day stream option is off. Same object until its inputs change. */
export function dayStreamFor(rootId: string): ViewStream | null {
  const features = getEditorFeatures();
  if (!features.dayStream) return null;
  // The index can drop a row for a moment while a claim re-syncs it (a
  // quick-add into today). A day root keeps its day through that gap, so the
  // stream does not collapse to one day and lose the scroll position.
  const key =
    getKeyForNode(rootId) ??
    (cached?.rootId === rootId ? cached.stream.anchor : null);
  if (key === null || scaffoldKeyKind(key) !== "day") return null;
  const today = localDateKey();
  const sig = `${rootId}|${key}|${features.emptyDays}|${today}`;
  if (cached?.sig !== sig)
    cached = {
      rootId,
      sig,
      stream: createDayStream(key, features.emptyDays, today),
    };
  return cached.stream;
}
