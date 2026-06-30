import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import { ChevronRight } from "lucide-react";
import type { Node } from "../data/schema";
import type { TagFilter } from "../data/tags";
import { useMirrorCount, useNode, useVisibleChildIds } from "../data/tree-store";
import { echoedTextFor } from "../data/collection";
import { isMirrorsEnabled } from "../data/flags";
import { MirrorBadge } from "./mirror-chrome";
import type { PluginContext } from "../plugins/types";
import { autoformat, slotsAt, useIsProtected } from "../plugins/registry";
import { clearSelection, useSelectionEdge } from "../data/selection-state";
import { useSlashMenu } from "./slash-menu";
import { useMenus } from "./menu-engine";
import { useBulletKeymap } from "./use-bullet-keymap";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  setCaretOffset,
  watchCaretReveal,
} from "./inline-code";
import { hasLink } from "../data/links";
import { pasteIntoBullet } from "./paste";
import { healProtectedText } from "./protected-text";
import { ProtectedLock } from "./protection";
import { placeCaretAtEnd, placeCaretAtStart } from "./caret-place";
import { flashRow } from "./flash-node";
import type { NodeCommands } from "./OutlineNode";

// Indent per depth level. Matches `.outline-children { padding-left }` in the
// recursive path -- the one number both render models and the drag projection
// agree on (use-drag-reorder.ts INDENT_FALLBACK). Once the recursive path is
// deleted (ADR 0019), this is the single source for outline indentation.
export const INDENT_PX = 24;

/**
 * One flat, windowed outline row (Phase B, ADR 0019). The virtualized
 * counterpart to {@link OutlineNode}: same bullet, same contentEditable, same
 * plugin slots/menus -- but it is a LEAF (no `OutlineNodeChildren` recursion),
 * its nesting is `depth`-driven padding rather than DOM structure, and it claims
 * pending focus/flash on its own mount (a scroll that mounts a row is not a tree
 * change, so the editor's central FocusPass can't see it).
 *
 * This intentionally duplicates OutlineNode's bullet during the flag window so
 * the recursive baseline stays untouched for e2e parity; the recursive path is
 * deleted (and this becomes the only row) when the flag flips.
 *
 * Mirrors (ADR 0022) split a row's identity in two: {@link nodeId} is the
 * INSTANCE (where the row physically sits -- its `parentId`, `collapsed`, drag
 * target, selection edge), {@link contentId} is the CONTENT (`text`, `isTask`,
 * `completed`, children). For a normal row they're equal and the row takes the
 * single-`useNode` fast path; only a mirror subscribes to both. The split is
 * inert while the mirrors flag is off (every row arrives with `contentId === id`,
 * `isMirror` false), so the 99% outline runs exactly today's code.
 */
export interface OutlineRowProps {
  // The INSTANCE node id (row.id) -- where this row physically sits. Drives
  // position, collapse, drag, selection, focus/flash claiming.
  nodeId: string;
  // The CONTENT node id (row.contentId): `mirrorOf ?? id`. Equal to nodeId for
  // every normal row; the source's id for a mirror. Drives text/task/completed
  // and the windowed children.
  contentId: string;
  // This row IS a mirror (its own `mirrorOf` is set). When false, nodeId ===
  // contentId and the row takes the single-subscription path.
  isMirror: boolean;
  // A mirror whose source is an expanded ancestor on this path (a cycle): render
  // the row but non-expandable, so the walk can't loop (ADR 0022).
  capped: boolean;
  // A mirror whose source resolves to no node: render a "source missing" leaf.
  broken: boolean;
  // Depth relative to the zoom root (direct child of the root = 0). Drives the
  // left indent. Comes from the flat list, stable per id until structure shifts.
  depth: number;
  // True when an ancestor within the view is completed (fade inheritance, ADR
  // 0002). Carried by the flat list, not threaded through a parent row.
  ancestorCompleted: boolean;
  commands: NodeCommands;
  pluginCtx: () => PluginContext;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  pivotId: string | null;
  isHidden: (node: Node) => boolean;
  filter: TagFilter | null;
  // Focus plumbing, claimed on mount. Stable refs (from useOutlineFocus).
  pendingFocus: RefObject<string | null>;
  pendingFocusAtStart: RefObject<boolean>;
  pendingFlash: RefObject<string | null>;
  // Virtualizer wiring. The row IS the positioned + measured element (so the
  // `li[data-node-id]` the e2e selectors and CSS expect stays an <li> directly
  // under the list <ul>). start/scrollMargin change on scroll -> the row
  // re-renders to reposition; that's expected for a windowed list, and the memo
  // still isolates TYPING (an unrelated keystroke changes none of these props).
  index: number;
  start: number;
  scrollMargin: number;
  measureRef: (el: HTMLLIElement | null) => void;
}

export const OutlineRow = memo(function OutlineRow(props: OutlineRowProps) {
  // Mirror split happens at the hook boundary (rules of hooks forbid a
  // conditional `useNode`): a mirror subscribes to two nodes, a normal row to
  // one. Both funnel into the same {@link RowChrome}.
  return props.isMirror ? <MirrorRow {...props} /> : <NormalRow {...props} />;
});

/** The mirror-free fast path: a single subscription, content === instance.
 *  Byte-identical to the pre-mirror row. */
function NormalRow({ nodeId, ...rest }: OutlineRowProps) {
  const node = useNode(nodeId);
  if (!node) return null;
  return <RowChrome instance={node} content={node} {...rest} />;
}

/** A mirror: the instance (position) and the content (source) are different
 *  nodes, so it subscribes to both. A missing source renders a leaf. */
function MirrorRow({ nodeId, contentId, broken, ...rest }: OutlineRowProps) {
  const instance = useNode(nodeId);
  const content = useNode(contentId);
  if (!instance) return null;
  if (broken || !content) {
    return (
      <MirrorMissingRow
        instance={instance}
        depth={rest.depth}
        index={rest.index}
        start={rest.start}
        scrollMargin={rest.scrollMargin}
        measureRef={rest.measureRef}
      />
    );
  }
  return <RowChrome instance={instance} content={content} {...rest} />;
}

type RowChromeProps = Omit<
  OutlineRowProps,
  "nodeId" | "contentId" | "broken"
> & {
  /** The position node (parentId/collapsed/drag/selection live here). */
  instance: Node;
  /** The content node (text/isTask/completed/children live here). */
  content: Node;
};

/**
 * The shared row body. Reads CONTENT from `content` (`mirrorOf ?? id`) and
 * POSITION from `instance` (the node id). For a normal row the two are the same
 * object, so nothing about the mirror-free path changes; for a mirror the text/
 * children/completed come from the source while collapse/drag/zoom/selection
 * stay on the instance (ADR 0022). Editing the mirror's text writes the SOURCE
 * (`commands.onTextChange(content.id, ...)`), which is how an edit in one place
 * shows up everywhere. Full caret/focus/drag parity inside a mirror is Stage 2.
 */
function RowChrome({
  instance,
  content,
  isMirror,
  capped,
  depth,
  ancestorCompleted,
  commands,
  pluginCtx,
  registerRef,
  pivotId,
  isHidden,
  filter,
  pendingFocus,
  pendingFocusAtStart,
  pendingFlash,
  index,
  start,
  scrollMargin,
  measureRef,
}: RowChromeProps) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);

  // Direct visible children of the CONTENT -- a mirror windows its source's
  // subtree, so the chevron + collapsed dot follow the source's children. No
  // recursion: the flat list already holds the descendants as their own rows.
  // With windowing only ~viewport rows call this, so the per-parent fan-out the
  // recursive path paid is gone.
  const childIds = useVisibleChildIds(content.id, isHidden);
  // Only the boolean is needed here (a leaf row has no children list to pass
  // down), so test emptiness without materializing the filtered array. A capped
  // mirror is never expandable (it would loop), so it shows no chevron.
  const hasChildren = capped
    ? false
    : filter
      ? childIds.some((id) => filter.visibleIds.has(id))
      : childIds.length > 0;
  // Collapse is LOCAL to the instance (a mirror collapsed here leaves the source
  // open elsewhere); fade/match/pivot follow the CONTENT.
  const effectiveCollapsed = filter ? false : instance.collapsed;
  const isContext = filter ? !filter.matchIds.has(content.id) : false;
  const isPivot = content.id === pivotId;
  const faded = content.completed || ancestorCompleted;

  const slash = useSlashMenu({
    node: content,
    ctx: pluginCtx,
    getEl: () => textRef.current,
    onTextChange: (text) => commands.onTextChange(content.id, text),
  });

  const beforeTextSlots = slotsAt("row:before-text");
  const protectedNode = useIsProtected(content.id);
  const selectionEdge = useSelectionEdge(instance.id);
  // Mirror chrome (ADR 0022, slice 1d). The count is the same for the source row
  // and every instance (they share the content id), so the "appears in N places"
  // badge shows on all of them. `mirrorsOn` is session-fixed, so the hook adds no
  // reactive work when the flag is off (useMirrorCount short-circuits).
  const mirrorsOn = isMirrorsEnabled();
  const mirrorCount = useMirrorCount(content.id, mirrorsOn);
  const isSource = !isMirror && mirrorCount > 0;

  const menus = useMenus({
    node: content,
    getEl: () => textRef.current,
    ctx: pluginCtx,
    onTextChange: (text) => commands.onTextChange(content.id, text),
  });

  // Mount: seed the span's text synchronously before paint (mirrors OutlineNode;
  // the update effect's focused-skip guard is unsafe until the DOM is populated).
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    decorate(el, content.text, null, false);
    syncedRef.current = content.text;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount: claim a pending focus/flash queued for THIS row. The editor's central
  // FocusPass handles rows already mounted at tree-change time; this handles a
  // row that mounts because we scrolled it into view (scrollRowIntoView), which
  // FocusPass never sees (a scroll isn't a tree change). Runs after the seed
  // effect above, so the caret lands on populated text. Keyed by the INSTANCE id
  // (pendingFocus carries position ids, set by the commands).
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (pendingFocus.current === instance.id) {
      el.focus();
      if (pendingFocusAtStart.current) placeCaretAtStart(el);
      else placeCaretAtEnd(el);
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
    }
    if (pendingFlash.current === instance.id) {
      flashRow(el.closest(".outline-row"));
      pendingFlash.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push store text into the contentEditable when it changes from something
  // other than this bullet's own typing (undo, programmatic setText, a genuine
  // echo, OR a sibling instance of the same source editing it -- the live mirror
  // sync). Identical to OutlineNode -- see there for the focused-skip rationale.
  useEffect(() => {
    const el = textRef.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === content.text) return;
    if (
      document.activeElement === el &&
      echoedTextFor(content.id) === content.text
    ) {
      return;
    }
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, content.text, revealOffset, focused);
    syncedRef.current = content.text;
  });

  // Unmount: tear down the caret-reveal watcher if it's still live. onBlur clears
  // it in the recursive path, but a windowed row can unmount while still focused
  // (its bullet scrolls out of the window), and a blur isn't guaranteed on DOM
  // disconnect -- so the document `selectionchange` listener would otherwise leak.
  useEffect(() => {
    return () => {
      caretWatchRef.current?.();
      caretWatchRef.current = null;
    };
  }, []);

  useBulletKeymap({
    node: content,
    textRef,
    commands,
    pluginCtx,
    hasChildren,
    enabled: !slash.isOpen && !menus.isOpen,
  });

  return (
    <li
      className="outline-node"
      data-node-id={instance.id}
      data-parent-id={instance.parentId ?? undefined}
      data-depth={depth}
      data-mirror={
        isMirror ? (capped ? "capped" : "instance") : isSource ? "source" : undefined
      }
      data-selected={selectionEdge ?? undefined}
      data-index={index}
      ref={measureRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start - scrollMargin}px)`,
        paddingInlineStart: depth * INDENT_PX,
      }}
    >
      <div className="outline-row" data-faded={faded} data-context={isContext}>
        <button
          type="button"
          className="collapse-toggle touch-hitbox"
          aria-label={effectiveCollapsed ? "Expand" : "Collapse"}
          data-has-children={hasChildren}
          data-collapsed={effectiveCollapsed}
          onClick={() =>
            hasChildren &&
            commands.onToggleCollapsed(instance.id, !instance.collapsed)
          }
          tabIndex={-1}
        >
          {hasChildren && <ChevronRight size={14} strokeWidth={2.5} />}
        </button>
        <button
          type="button"
          className="bullet touch-hitbox"
          aria-label="Zoom in"
          onPointerDown={(e) => commands.onBulletPointerDown(instance.id, e)}
          // A mirror's bullet zooms to the SOURCE (content.id) -- you land on the
          // real node to work its subtree. For a normal row content.id ===
          // instance.id, so this is today's behavior.
          onClick={() => commands.onBulletClick(content.id)}
          title="Zoom in"
        >
          <span
            className="bullet-dot"
            data-completed={content.completed}
            data-has-children={hasChildren}
            data-collapsed={effectiveCollapsed}
          />
        </button>
        {beforeTextSlots.map((slot) => (
          <Fragment key={slot.id}>{slot.render(content, pluginCtx)}</Fragment>
        ))}
        {protectedNode && <ProtectedLock size={12} />}
        {mirrorsOn && mirrorCount > 0 && (
          <MirrorBadge sourceId={content.id} count={mirrorCount} />
        )}
        <span
          ref={(el) => {
            textRef.current = el;
            registerRef(instance.id, el);
          }}
          className={`node-text${isPivot ? " vt-morph" : ""}`}
          style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          aria-label={content.text.trim() || "Empty bullet"}
          aria-multiline="true"
          data-completed={content.completed}
          onInput={(e) => {
            const el = e.currentTarget;
            const text = readSource(el);
            if (!composingRef.current) {
              const af = autoformat({ text, node: content });
              if (af) {
                af.before?.(pluginCtx());
                commands.onTextChange(content.id, af.text);
                decorate(el, af.text, af.caret, false);
                syncedRef.current = af.text;
                setCaretOffset(el, af.caret);
                return;
              }
            }
            commands.onTextChange(content.id, text);
            slash.handleInput();
            menus.handleInput();
            if (!composingRef.current) {
              decorate(el, text, getCaretOffset(el), true);
              syncedRef.current = text;
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const el = e.currentTarget;
            const text = readSource(el);
            commands.onTextChange(content.id, text);
            decorate(el, text, getCaretOffset(el), true);
            syncedRef.current = text;
          }}
          onPaste={(e) => {
            const el = e.currentTarget;
            const next = pasteIntoBullet(e, el, content.id, pluginCtx, (t) =>
              commands.onTextChange(content.id, t),
            );
            if (next !== null) syncedRef.current = next;
          }}
          onFocus={(e) => {
            clearSelection();
            const el = e.currentTarget;
            caretWatchRef.current?.();
            caretWatchRef.current = watchCaretReveal(
              el,
              () => composingRef.current,
            );
            if (!hasLink(content.text)) return;
            revealLinkAtCaret(el, content.text, () => {
              syncedRef.current = content.text;
            });
          }}
          onBlur={(e) => {
            slash.close();
            menus.close();
            caretWatchRef.current?.();
            caretWatchRef.current = null;
            const el = e.currentTarget;
            const text = readSource(el);
            const restored = healProtectedText(content.id, text, el);
            if (restored !== null) {
              syncedRef.current = restored;
            } else if (hasLink(text)) {
              decorate(el, text, null, false);
              syncedRef.current = text;
            }
          }}
          onKeyDown={(e) => {
            if (menus.handleKeyDown(e)) return;
            slash.handleKeyDown(e);
          }}
        />
        {slash.menu}
        {menus.menu}
      </div>
    </li>
  );
}

/**
 * A mirror whose source resolves to no node (ADR 0022): render a non-editable
 * "source missing" leaf in the instance's position, never recurse, never throw.
 * Kept deliberately bare for slice 1b -- the richer broken-mirror chrome (a jump
 * affordance, distinct styling) lands with the rest of the mirror chrome.
 */
function MirrorMissingRow({
  instance,
  depth,
  index,
  start,
  scrollMargin,
  measureRef,
}: {
  instance: Node;
  depth: number;
  index: number;
  start: number;
  scrollMargin: number;
  measureRef: (el: HTMLLIElement | null) => void;
}) {
  return (
    <li
      className="outline-node"
      data-node-id={instance.id}
      data-parent-id={instance.parentId ?? undefined}
      data-depth={depth}
      data-mirror="broken"
      data-index={index}
      ref={measureRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${start - scrollMargin}px)`,
        paddingInlineStart: depth * INDENT_PX,
      }}
    >
      <div className="outline-row" data-faded={true}>
        <span className="collapse-toggle touch-hitbox" aria-hidden="true" />
        <span className="bullet touch-hitbox" aria-hidden="true">
          <span className="bullet-dot" data-broken="true" />
        </span>
        <span className="node-text" aria-label="Mirror source not found">
          Mirror (source not found)
        </span>
      </div>
    </li>
  );
}
