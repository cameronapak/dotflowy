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
import { useNode, useVisibleChildIds } from "../data/tree-store";
import { echoedTextFor } from "../data/collection";
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
 */
export interface OutlineRowProps {
  nodeId: string;
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

export const OutlineRow = memo(function OutlineRow({
  nodeId,
  ...rest
}: OutlineRowProps) {
  const node = useNode(nodeId);
  if (!node) return null;
  return <OutlineRowBody node={node} {...rest} />;
});

function OutlineRowBody({
  node,
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
}: Omit<OutlineRowProps, "nodeId"> & { node: Node }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);

  // Direct visible children only -- drives the collapse chevron + collapsed dot.
  // No recursion: the flat list already holds the descendants as their own rows.
  // With windowing only ~viewport rows call this, so the per-parent fan-out the
  // recursive path paid is gone.
  const childIds = useVisibleChildIds(node.id, isHidden);
  const visibleChildIds = filter
    ? childIds.filter((id) => filter.visibleIds.has(id))
    : childIds;
  const hasChildren = visibleChildIds.length > 0;
  const effectiveCollapsed = filter ? false : node.collapsed;
  const isContext = filter ? !filter.matchIds.has(node.id) : false;
  const isPivot = node.id === pivotId;
  const faded = node.completed || ancestorCompleted;

  const slash = useSlashMenu({
    node,
    ctx: pluginCtx,
    getEl: () => textRef.current,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  const beforeTextSlots = slotsAt("row:before-text");
  const protectedNode = useIsProtected(node.id);
  const selectionEdge = useSelectionEdge(node.id);

  const menus = useMenus({
    node,
    getEl: () => textRef.current,
    ctx: pluginCtx,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  // Mount: seed the span's text synchronously before paint (mirrors OutlineNode;
  // the update effect's focused-skip guard is unsafe until the DOM is populated).
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    decorate(el, node.text, null, false);
    syncedRef.current = node.text;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount: claim a pending focus/flash queued for THIS row. The editor's central
  // FocusPass handles rows already mounted at tree-change time; this handles a
  // row that mounts because we scrolled it into view (scrollRowIntoView), which
  // FocusPass never sees (a scroll isn't a tree change). Runs after the seed
  // effect above, so the caret lands on populated text.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (pendingFocus.current === node.id) {
      el.focus();
      if (pendingFocusAtStart.current) placeCaretAtStart(el);
      else placeCaretAtEnd(el);
      pendingFocus.current = null;
      pendingFocusAtStart.current = false;
    }
    if (pendingFlash.current === node.id) {
      flashRow(el.closest(".outline-row"));
      pendingFlash.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push store text into the contentEditable when it changes from something
  // other than this bullet's own typing (undo, programmatic setText, a genuine
  // echo). Identical to OutlineNode -- see there for the focused-skip rationale.
  useEffect(() => {
    const el = textRef.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    if (document.activeElement === el && echoedTextFor(node.id) === node.text) {
      return;
    }
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, node.text, revealOffset, focused);
    syncedRef.current = node.text;
  });

  useBulletKeymap({
    node,
    textRef,
    commands,
    pluginCtx,
    hasChildren,
    enabled: !slash.isOpen && !menus.isOpen,
  });

  return (
    <li
      className="outline-node"
      data-node-id={node.id}
      data-parent-id={node.parentId ?? undefined}
      data-depth={depth}
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
            hasChildren && commands.onToggleCollapsed(node.id, !node.collapsed)
          }
          tabIndex={-1}
        >
          {hasChildren && <ChevronRight size={14} strokeWidth={2.5} />}
        </button>
        <button
          type="button"
          className="bullet touch-hitbox"
          aria-label="Zoom in"
          onPointerDown={(e) => commands.onBulletPointerDown(node.id, e)}
          onClick={() => commands.onBulletClick(node.id)}
          title="Zoom in"
        >
          <span
            className="bullet-dot"
            data-completed={node.completed}
            data-has-children={hasChildren}
            data-collapsed={effectiveCollapsed}
          />
        </button>
        {beforeTextSlots.map((slot) => (
          <Fragment key={slot.id}>{slot.render(node, pluginCtx)}</Fragment>
        ))}
        {protectedNode && <ProtectedLock size={12} />}
        <span
          ref={(el) => {
            textRef.current = el;
            registerRef(node.id, el);
          }}
          className={`node-text${isPivot ? " vt-morph" : ""}`}
          style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          aria-label={node.text.trim() || "Empty bullet"}
          aria-multiline="true"
          data-completed={node.completed}
          onInput={(e) => {
            const el = e.currentTarget;
            const text = readSource(el);
            if (!composingRef.current) {
              const af = autoformat({ text, node });
              if (af) {
                af.before?.(pluginCtx());
                commands.onTextChange(node.id, af.text);
                decorate(el, af.text, af.caret, false);
                syncedRef.current = af.text;
                setCaretOffset(el, af.caret);
                return;
              }
            }
            commands.onTextChange(node.id, text);
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
            commands.onTextChange(node.id, text);
            decorate(el, text, getCaretOffset(el), true);
            syncedRef.current = text;
          }}
          onPaste={(e) => {
            const el = e.currentTarget;
            const next = pasteIntoBullet(e, el, node.id, pluginCtx, (t) =>
              commands.onTextChange(node.id, t),
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
            if (!hasLink(node.text)) return;
            revealLinkAtCaret(el, node.text, () => {
              syncedRef.current = node.text;
            });
          }}
          onBlur={(e) => {
            slash.close();
            menus.close();
            caretWatchRef.current?.();
            caretWatchRef.current = null;
            const el = e.currentTarget;
            const text = readSource(el);
            const restored = healProtectedText(node.id, text, el);
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
