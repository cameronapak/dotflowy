// Editor-side glue for view streams (ADR 0070): subscribe to the plugin's
// stream for this zoom root, build its sections + rows, and interleave the
// section chrome (titles, placeholders, folds, page ends) with the presented
// rows into the one list the virtualizer windows.

import { useCallback, useRef, useSyncExternalStore } from "react";

import type { Node } from "../data/tree";
import type { VisibleRow } from "../data/visible-order";

import { isMirrorsEnabled } from "../data/flags";
import {
  getStructureRev,
  getTreeIndex,
  subscribeTree,
} from "../data/tree-store";
import {
  buildStream,
  type StreamBuild,
  type StreamSection,
  type ViewStream,
} from "../data/view-stream";
import { getViewStream, subscribeViewStreams } from "../plugins/registry";

/** One entry of the windowed list. Outside a stream every entry is a row. */
export type ListItem =
  | { kind: "row"; key: string; row: VisibleRow }
  /** A section's title; `key` is the section node id, so focus, refs, and
   *  scroll address it like the zoomed title. */
  | { kind: "title"; key: string; section: string; nodeId: string }
  /** A section with no node yet: its title and a line to start writing. */
  | { kind: "placeholder"; key: string; section: string }
  /** A run of empty sections folded into one line. */
  | { kind: "fold"; key: string; sections: string[] }
  /** Bottom of a section: tops the page up so each section fills a screen. */
  | {
      kind: "end";
      key: string;
      section: string;
      /** The section's node when it has one and nothing visible inside it,
       *  so the end can offer a line to start writing. */
      emptyNodeId: string | null;
    };

let streamVersion = 0;
function subscribeStreamInputs(cb: () => void): () => void {
  const offTree = subscribeTree(cb);
  const offStreams = subscribeViewStreams(() => {
    streamVersion++;
    cb();
  });
  return () => {
    offTree();
    offStreams();
  };
}

/** The stream for this zoom root, or null for an ordinary zoom view. */
export function useViewStream(
  rootId: string | null,
  enabled: boolean,
): ViewStream | null {
  const getSnapshot = useCallback(
    () => (enabled ? getViewStream(rootId) : null),
    [rootId, enabled],
  );
  return useSyncExternalStore(subscribeViewStreams, getSnapshot, () => null);
}

export interface StreamSnapshot extends StreamBuild {
  /** Whether the stream's bounds clipped the loaded range on that side, so
   *  scrolling further has nothing more to load. */
  atStart: boolean;
  atEnd: boolean;
}

const EMPTY_SNAPSHOT: StreamSnapshot = {
  sections: [],
  rows: [],
  rowSection: new Map(),
  atStart: true,
  atEnd: true,
};

/** Build the stream's sections and rows for `before` sections ahead of the
 *  anchor and `after` past it. Rebuilt only on a structural change, a stream
 *  signal, or a change in what is loaded -- never on a keystroke. */
export function useStreamBuild(
  stream: ViewStream | null,
  before: number,
  after: number,
  isHidden: (n: Node) => boolean,
  expanded: ReadonlySet<string>,
): StreamSnapshot {
  const cache = useRef<{
    rev: number;
    version: number;
    stream: ViewStream | null;
    before: number;
    after: number;
    isHidden: (n: Node) => boolean;
    expanded: ReadonlySet<string>;
    snapshot: StreamSnapshot;
  } | null>(null);
  const getSnapshot = useCallback(() => {
    const rev = getStructureRev();
    const c = cache.current;
    if (
      c &&
      c.rev === rev &&
      c.version === streamVersion &&
      c.stream === stream &&
      c.before === before &&
      c.after === after &&
      c.isHidden === isHidden &&
      c.expanded === expanded
    )
      return c.snapshot;
    let snapshot = EMPTY_SNAPSHOT;
    if (stream) {
      const { keys, atStart, atEnd } = stream.keys(before, after);
      snapshot = {
        ...buildStream(
          getTreeIndex(),
          stream,
          keys,
          isHidden,
          isMirrorsEnabled(),
          expanded,
        ),
        atStart,
        atEnd,
      };
    }
    cache.current = {
      rev,
      version: streamVersion,
      stream,
      before,
      after,
      isHidden,
      expanded,
      snapshot,
    };
    return snapshot;
  }, [stream, before, after, isHidden, expanded]);
  return useSyncExternalStore(
    subscribeStreamInputs,
    getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
}

/**
 * Interleave section chrome with the presented rows. `presented` is the
 * completion transition's list: the build's rows plus rows still fading out,
 * which keep the section of the row before them.
 */
export function interleaveStream(
  sections: readonly StreamSection[],
  rowSection: ReadonlyMap<string, string>,
  presented: readonly VisibleRow[],
): ListItem[] {
  const bySection = new Map<string, VisibleRow[]>();
  let current: string | null = null;
  for (const row of presented) {
    current = rowSection.get(row.key) ?? current;
    if (current === null) continue;
    const list = bySection.get(current);
    if (list) list.push(row);
    else bySection.set(current, [row]);
  }
  const items: ListItem[] = [];
  for (const section of sections) {
    if (section.kind === "fold") {
      items.push({ kind: "fold", key: section.key, sections: section.keys });
      continue;
    }
    if (section.kind === "placeholder") {
      items.push({
        kind: "placeholder",
        key: `stream:${section.key}`,
        section: section.key,
      });
      items.push({
        kind: "end",
        key: `stream-end:${section.key}`,
        section: section.key,
        emptyNodeId: null,
      });
      continue;
    }
    items.push({
      kind: "title",
      key: section.nodeId,
      section: section.key,
      nodeId: section.nodeId,
    });
    const rows = bySection.get(section.key) ?? [];
    for (const row of rows) items.push({ kind: "row", key: row.key, row });
    items.push({
      kind: "end",
      key: `stream-end:${section.key}`,
      section: section.key,
      emptyNodeId: rows.length === 0 ? section.nodeId : null,
    });
  }
  return items;
}
