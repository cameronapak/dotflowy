// The view stream (ADR 0070): a zoom root that continues into neighboring
// roots, rendered as one flat, windowed list. Core owns the list shape, the
// "which section is in view" store, and the event-time scroll bridge; a plugin
// owns what a section means (the Daily plugin's calendar days). Core never
// learns what a day is (ADR 0001).

import { useSyncExternalStore } from "react";

import type { Node, TreeIndex } from "./tree";

import { buildVisibleRows, type VisibleRow } from "./visible-order";

/** How a stream presents sections with nothing in them. */
export type EmptySectionMode = "show" | "fold" | "skip";

/**
 * One stream, as a plugin describes it for a zoom root. Section keys are
 * opaque to core; their order is the plugin's.
 */
export interface ViewStream {
  /** The section key of the zoom root itself. */
  anchor: string;
  /** Section keys in display order, from `before` sections ahead of the
   *  anchor to `after` sections past it, clipped to the stream's bounds.
   *  `atStart`/`atEnd` report whether a bound clipped that side. */
  keys(
    before: number,
    after: number,
  ): { keys: string[]; atStart: boolean; atEnd: boolean };
  /** Signed section distance from the anchor, or null when `key` is not a
   *  section of this stream. */
  offsetOf(key: string): number | null;
  /** The section's node id, or null while it has none yet. Live. */
  resolve(key: string): string | null;
  /** Whether a section has nothing in it. Reads the live tree. */
  isEmpty(key: string, index: TreeIndex): boolean;
  emptyMode: EmptySectionMode;
  /** Sections that are never folded or skipped. */
  pinned(key: string): boolean;
  /** Title text for a section that has no node yet. */
  placeholderTitle(key: string): string;
  /** A short relative label shown beside a nodeless section's title. */
  badge(key: string): string | null;
  /** One line describing a run of folded sections. */
  foldLabel(keys: readonly string[]): string;
  /** The node whose breadcrumb trail stands in while a nodeless section is in
   *  view, or null for none. */
  trailFor(key: string): string | null;
  /** Create the section's node with one empty entry line. Resolves to both
   *  ids, or null when creation failed (the plugin reports the failure). */
  create(key: string): Promise<{ id: string; entryId: string } | null>;
}

/** One section of the built stream, in display order. */
export type StreamSection =
  | { kind: "node"; key: string; nodeId: string; empty: boolean }
  | { kind: "placeholder"; key: string }
  | { kind: "fold"; key: string; keys: string[] };

export interface StreamBuild {
  sections: StreamSection[];
  /** The node rows of every node section, concatenated in display order.
   *  Each row's depth is relative to its own section root. */
  rows: VisibleRow[];
  /** row key -> the section key it belongs to. */
  rowSection: Map<string, string>;
}

/**
 * Build the stream's sections and rows. Pure.
 *
 * An empty section shows (`show`), joins a run of folded sections (`fold`), or
 * drops out (`skip`). Pinned and expanded sections always show.
 */
export function buildStream(
  index: TreeIndex,
  stream: ViewStream,
  keys: readonly string[],
  isHidden: (n: Node) => boolean,
  mirrorsEnabled: boolean,
  expanded: ReadonlySet<string>,
): StreamBuild {
  const sections: StreamSection[] = [];
  const rows: VisibleRow[] = [];
  const rowSection = new Map<string, string>();
  for (const key of keys) {
    const nodeId = stream.resolve(key);
    const present = nodeId !== null && index.byId.has(nodeId);
    const empty = !present || stream.isEmpty(key, index);
    if (
      empty &&
      stream.emptyMode !== "show" &&
      !stream.pinned(key) &&
      !expanded.has(key)
    ) {
      if (stream.emptyMode === "skip") continue;
      const last = sections[sections.length - 1];
      if (last?.kind === "fold") last.keys.push(key);
      else sections.push({ kind: "fold", key: `fold:${key}`, keys: [key] });
      continue;
    }
    if (!present) {
      sections.push({ kind: "placeholder", key });
      continue;
    }
    sections.push({ kind: "node", key, nodeId, empty });
    for (const row of buildVisibleRows(
      index,
      nodeId,
      isHidden,
      null,
      mirrorsEnabled,
    )) {
      rows.push(row);
      rowSection.set(row.key, key);
    }
  }
  return { sections, rows, rowSection };
}

// --- Which section is in view ----------------------------------------------
//
// The editor publishes the section under the sticky header; plugin chrome (the
// week strip) and the URL follow it. Null while no stream is mounted.

export interface StreamView {
  anchor: string;
  inView: string;
}

let view: StreamView | null = null;
const listeners = new Set<() => void>();

export function setStreamView(next: StreamView | null): void {
  if (
    view === next ||
    (view && next && view.anchor === next.anchor && view.inView === next.inView)
  )
    return;
  view = next;
  for (const l of listeners) l();
}

export function getStreamView(): StreamView | null {
  return view;
}

function subscribeStreamView(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The mounted stream's anchor and in-view section, or null. */
export function useStreamView(): StreamView | null {
  return useSyncExternalStore(subscribeStreamView, getStreamView, () => null);
}

// --- Event-time scroll bridge ------------------------------------------------

let scroller: ((key: string, focusKey?: string) => boolean) | null = null;

/** The editor wires this while a stream is mounted. */
export function setStreamScroller(
  next: ((key: string, focusKey?: string) => boolean) | null,
) {
  scroller = next;
}

/** Scroll the mounted stream to a section, loading it when needed, and
 *  optionally put the caret at the end of `focusKey` (a row in it). Returns
 *  false when no stream is mounted or `key` is not one of its sections, so the
 *  caller can navigate instead. */
export function scrollStreamTo(key: string, focusKey?: string): boolean {
  return scroller?.(key, focusKey) ?? false;
}

// --- Event-time caret walk ---------------------------------------------------
//
// Inside a stream the rendered sequence crosses section boundaries, so the
// caret walk follows the list itself rather than one root's subtree.

let neighbor:
  | ((key: string, direction: "up" | "down") => string | null)
  | null = null;

/** The editor wires this while a stream is mounted. */
export function setStreamNeighbor(
  next: ((key: string, direction: "up" | "down") => string | null) | null,
) {
  neighbor = next;
}

/** The focusable neighbor of `key` in the mounted stream: a row or a section
 *  title. `undefined` when no stream is mounted, so the caller walks the zoom
 *  root instead. */
export function streamNeighbor(
  key: string,
  direction: "up" | "down",
): string | null | undefined {
  return neighbor ? neighbor(key, direction) : undefined;
}
