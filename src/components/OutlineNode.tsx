import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent,
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
import { hasFoldingToken } from "../plugins/registry";
import {
  copySourceSelection,
  cutSourceSelection,
  pasteIntoBullet,
} from "./paste";
import { healProtectedText } from "./protected-text";
import { ProtectedLock } from "./protection";

interface OutlineNodeProps {
  // The node id. The node itself and its visible children are read reactively
  // from the shared tree store (useNode / useVisibleChildIds), NOT threaded as
  // props -- that's what lets a keystroke re-render only the bullet that
  // changed instead of the whole tree. See ADR 0014.
  nodeId: string;
  // Commands the editor knows how to run. Keeping them as a single
  // object avoids each node importing mutations + focus logic directly.
  // Must be referentially stable, or every node re-renders on every keystroke.
  commands: NodeCommands;
  // The PluginContext factory (ADR 0001 D8), for the caret menu engine (Seam H)
  // and any other plugin surface a bullet drives. Stable (a useCallback in the
  // editor), so it doesn't break OutlineNode's memo. Read live at event time.
  pluginCtx: () => PluginContext;
  // Refs registry so the editor can move focus between bullets.
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  // The node currently morphing across a zoom navigation, if any. When this
  // node is the pivot, its text claims the shared view-transition-name.
  pivotId: string | null;
  // True when an ancestor *within the current view* is completed, so this row
  // renders faded even if it isn't itself completed. Visual-only inheritance;
  // never written to data. Resets to false at each zoom root. See ADR 0002.
  ancestorCompleted: boolean;
  // The composed Seam-G visibility predicate (ADR 0001): a node is pruned from
  // the render iff it returns true (hide-completed when show-completed is off).
  // Replaces the old `showCompleted` boolean -- this node no longer knows the
  // hide rule, it just applies the predicate. Stable across keystrokes.
  isHidden: (node: Node) => boolean;
  // Active tag filter, or null when none. When set, this node renders only if
  // it's in `visibleIds`; it's a match (normal styling) when in `matchIds`,
  // otherwise dimmed ancestor context. Filtering is render-time, so `collapsed`
  // is ignored -- matches inside collapsed subtrees are revealed. See ADR 0015.
  filter: TagFilter | null;
}

export interface NodeCommands {
  onTextChange: (id: string, text: string) => void;
  // `caretOffset` is the absolute character offset of the caret within the
  // bullet's text, so the editor can split the line at the caret.
  onEnter: (id: string, caretOffset: number) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  // Move a bullet (and its subtree) up/down among siblings; at the edge it
  // reparents into the parent's adjacent sibling. See ADR 0009.
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  // Delete a bullet and its entire subtree, then focus a neighbor.
  onDeleteNode: (id: string) => void;
  onToggleCompleted: (id: string, completed: boolean) => void;
  // Set whether a bullet is a task (checkbox shown/hidden).
  onSetTask: (id: string, isTask: boolean) => void;
  // Open the `/move` destination picker for this bullet.
  onRequestMove: (id: string) => void;
  // Open the `/mirror` destination picker for this bullet (ADR 0022): same
  // picker, but a pick creates a live mirror under the destination.
  onRequestMirror: (id: string) => void;
  onToggleCollapsed: (id: string, collapsed: boolean) => void;
  // `x` is the caret's viewport x at the moment of the keypress, so the
  // landing node can drop the caret at the same column. Omitted for horizontal
  // snaking: up lands at the previous row's end, down at the next row's start.
  onMoveFocus: (id: string, direction: "up" | "down", x?: number) => void;
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void;
  // Drag-to-reorder, hung off the bullet dot. pointerdown arms a drag; click
  // zooms only when no drag happened. See ADR 0010.
  onBulletPointerDown: (id: string, e: PointerEvent) => void;
  onBulletClick: (id: string) => void;
}

/**
 * Thin reactive wrapper: reads this node from the shared store and renders the
 * body only when it exists. Memoized so a parent re-render skips it when its
 * (stable) props are unchanged; its own `useNode` subscription still re-renders
 * it when THIS node's data changes. The early return lives here -- before any
 * other hooks -- so the rules of hooks hold while still letting a deleted node
 * (id present in a parent's stale snapshot) render nothing. See ADR 0014.
 */
export const OutlineNode = memo(function OutlineNode({
  nodeId,
  ...rest
}: OutlineNodeProps) {
  const node = useNode(nodeId);
  if (!node) return null;
  return <OutlineNodeBody node={node} {...rest} />;
});

function OutlineNodeBody({
  node,
  commands,
  pluginCtx,
  registerRef,
  pivotId,
  ancestorCompleted,
  isHidden,
  filter,
}: Omit<OutlineNodeProps, "nodeId"> & { node: Node }) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  // Inline `code` is decorated LIVE -- the contentEditable always holds
  // formatted HTML (mono chips), even while the caret is in the bullet. Each
  // keystroke re-tokenizes the line and rebuilds its DOM, so we save the caret
  // as an absolute character offset before the rebuild and restore it after
  // (see decorate()). Backticks stay visible inside the chip, which keeps the
  // source offset and the displayed offset identical -- no position mapping.
  //
  // Last text written to the DOM, so the sync effect skips redundant rebuilds
  // (and the caret-jitter they'd cause) on unrelated re-renders.
  const syncedRef = useRef<string | null>(null);
  // True between compositionstart/end (IME: accents, CJK). Rebuilding the DOM
  // mid-composition aborts the IME session, so we suspend decoration until it
  // ends, then decorate once with the committed text.
  const composingRef = useRef(false);
  // Cleanup for the per-link reveal watcher, live only while this bullet is
  // focused (added in onFocus, called in onBlur). See ADR 0005.
  const caretWatchRef = useRef<(() => void) | null>(null);
  // Visible child ids, read reactively from the store. The array keeps its
  // identity until the child set/order changes, so typing in a child doesn't
  // re-render this parent; a completion toggle that flips visibility does. A
  // hidden completed node takes its whole subtree with it for free.
  const childIds = useVisibleChildIds(node.id, isHidden);
  // While filtering, only children on a path to a match stay visible, and the
  // collapse state is ignored so matches inside a closed subtree are revealed.
  // Filtering never mutates `collapsed` -- clearing the filter restores the
  // exact prior view (ADR 0015).
  const visibleChildIds = filter
    ? childIds.filter((id) => filter.visibleIds.has(id))
    : childIds;
  const hasChildren = visibleChildIds.length > 0;
  const effectiveCollapsed = filter ? false : node.collapsed;
  // Dimmed when this node is only here as ancestor context for a match below it.
  const isContext = filter ? !filter.matchIds.has(node.id) : false;
  const isPivot = node.id === pivotId;
  // Faded when this bullet is done, or sits anywhere under one that is.
  const faded = node.completed || ancestorCompleted;

  // The "/" command menu for this bullet. Only the focused bullet ever has a
  // caret, so at most one menu is open across the whole outline. Its command
  // list is registry-driven now (Seam C: `/todo`/`/bullet` are the todos
  // plugin's, `/move` core); a picked command runs with pluginCtx().
  const slash = useSlashMenu({
    node,
    ctx: pluginCtx,
    getEl: () => textRef.current,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  // Plugin row slots for this bullet (Seam F): the todos checkbox renders here
  // when the node is a task. Stable array (precomputed in the registry), so it
  // never perturbs this memoized node's render.
  const beforeTextSlots = slotsAt("row:before-text");

  // Whether a plugin protects this node (the daily container) -- drives the
  // lock affordance below. Reactive: the daily index loads async, so this must
  // re-render when the `container -> nodeId` mapping resolves, not only on an
  // unrelated re-render (the old bare `isProtected(node.id)` read made the lock
  // appear late, only after a zoom).
  const protectedNode = useIsProtected(node.id);

  // This node's slot in a node multi-selection (ADR 0018), read as its OWN
  // slice: only rows entering/leaving the selection re-render, never a sibling's
  // (the same per-node-render isolation `useIsProtected` gives -- ADR 0014).
  // Drives the slab tint + rounded outer corners on the `<li>` below; null on a
  // node that isn't a selected root (a selected root's `<li>` background already
  // tints its whole subtree, so descendants need no per-row marker).
  const selectionEdge = useSelectionEdge(node.id);

  // Plugin caret menus (ADR 0001 Seam H): typing a trigger char ("#") opens an
  // autocomplete driven by the plugin that registered it (the tags plugin's tag
  // menu). The engine is generic; it coexists with the slash menu -- different
  // trigger chars, at most one open at a time.
  const menus = useMenus({
    node,
    getEl: () => textRef.current,
    ctx: pluginCtx,
    onTextChange: (text) => commands.onTextChange(node.id, text),
  });

  // First population of a freshly-mounted span: ALWAYS write the stored text
  // here, synchronously before paint and before FocusPass's passive el.focus()
  // can claim the span. A reparent (move/outdent/drag) unmounts OutlineNodeBody
  // at the old position and mounts a fresh instance at the new one -- empty
  // <span>, syncedRef back to null -- and every move also sets pendingFocus, so
  // FocusPass focuses that empty span. The update effect's focused-skip guard
  // below is load-bearing for the keystroke path (it stops a lagging echo from
  // repainting mid-type), but it is unsafe until onInput has populated the DOM,
  // which never happens on a fresh mount. Seeding the span here -- a layout
  // effect, so pre-paint and ahead of any passive focus -- means the guard is
  // never reached on mount, the text is never missing, and the caret logic in
  // FocusPass runs against a populated node. See ADR 0014 (per-node store) and
  // the move reparent in mutations.ts.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    decorate(el, node.text, null, false);
    syncedRef.current = node.text;
    // Mount-only: the update effect below owns every subsequent reconciliation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push stored text into the contentEditable as formatted HTML when it
  // changes from something OTHER than this bullet's own typing -- undo, a
  // programmatic setText, an echo that carries a genuinely different value.
  // The guard (syncedRef === node.text) makes the common echo-after-keystroke
  // a no-op: onInput already decorated and recorded the text, so the store
  // round-trip rebuilds nothing and the caret never moves. We skip
  // mid-composition; compositionend re-syncs. (Initial mount is owned by the
  // layout effect above, so on the first render syncedRef already === node.text
  // and this early-returns.)
  useEffect(() => {
    const el = textRef.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    // While THIS bullet is focused the contentEditable DOM is the source of
    // truth -- onInput already wrote the latest text. A store change that just
    // echoes the network back (node.text === the last synced/echoed value) is a
    // lagging or out-of-order echo of our own keystrokes; repainting it here is
    // what scrambles characters and jumps the caret mid-type, so skip it. A
    // LOCAL change (undo/redo, a programmatic setText) carries a value that does
    // NOT match the echo, so it falls through and still repaints. Reconciliation
    // for the skipped case happens on blur (onBlur re-reads the DOM). See
    // collection.ts `echoedText`.
    if (document.activeElement === el && echoedTextFor(node.id) === node.text) {
      return;
    }
    // A focused bullet reveals the link under its caret (per-link); a blurred
    // one folds every link. The focus/blur handlers own the swap when only
    // focus changes; this effect handles store-driven text changes (mount,
    // undo, programmatic setText). Preserve the caret only when focused (e.g.
    // undo while editing). See ADR 0005.
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, node.text, revealOffset, focused);
    syncedRef.current = node.text;
  });

  // This bullet's keyboard shortcuts (Enter/Tab/Backspace/Arrows/zoom + the
  // plugin keymap), scoped to its contentEditable. Disabled while a "/" or "#"
  // menu is open so the menu owns Arrow/Enter/Tab/Esc. See use-bullet-keymap.ts.
  useBulletKeymap({
    node,
    // Flag-off recursive path: no mirrors, so instance === content === node.
    instanceId: node.id,
    instanceCollapsed: node.collapsed,
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
      data-selected={selectionEdge ?? undefined}
    >
      <div className="outline-row" data-faded={faded} data-context={isContext}>
        <button
          type="button"
          className="collapse-toggle touch-hitbox"
          aria-label={effectiveCollapsed ? "Expand" : "Collapse"}
          data-has-children={hasChildren}
          data-collapsed={effectiveCollapsed}
          // Childless rows render no glyph but keep the gutter clickable-free.
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
            // readSource (not textContent) is the markdown source: a focused
            // bullet may still hold folded links, whose label != source.
            const text = readSource(el);
            // Plugin autoformat (Seam I): a markdown-style shortcut rewrites the
            // line (todos' "[]"/"[ ]" -> task + strip marker). The plugin's
            // side effect runs first (flip the type), then the core writes the
            // new text and places the caret. Suspended during IME composition.
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
            // Re-decorate live, revealing the link under the caret. Preserves
            // the caret. Suspended during IME composition; compositionend
            // handles that case.
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
          // Copy/cut hand back the markdown SOURCE (a folded link's rendered
          // text drops the url half). See copySourceSelection (ADR 0005).
          onCopy={(e) => copySourceSelection(e, e.currentTarget)}
          onCut={(e) => {
            const el = e.currentTarget;
            const next = cutSourceSelection(e, el, (t) =>
              commands.onTextChange(node.id, t),
            );
            if (next !== null) syncedRef.current = next;
          }}
          onFocus={(e) => {
            // A caret and a node selection are mutually exclusive (ADR 0018):
            // focusing any bullet leaves selection mode. Covers "click clears ->
            // normal edit" and the caret landing after a while-selected arrow.
            clearSelection();
            // Per-link reveal: watch the caret so exactly the link it's on shows
            // raw markdown (ADR 0005). The watcher lives only while focused.
            const el = e.currentTarget;
            caretWatchRef.current?.();
            caretWatchRef.current = watchCaretReveal(
              el,
              () => composingRef.current,
            );
            // Reveal the link under the caret (the watcher only fires on
            // subsequent moves). A link-free bullet is a no-op -- nothing folds
            // -- so the native click caret stands untouched. Deferred to the
            // next frame so a CLICK at the line's end settles on the folded
            // layout before the link expands; see revealLinkAtCaret.
            if (!hasFoldingToken(node.text)) return;
            revealLinkAtCaret(el, (t) => {
              syncedRef.current = t;
            });
          }}
          onBlur={(e) => {
            slash.close();
            menus.close();
            caretWatchRef.current?.();
            caretWatchRef.current = null;
            const el = e.currentTarget;
            const text = readSource(el);
            // A protected node left empty heals: restore its name + shake/toast.
            const restored = healProtectedText(node.id, text, el);
            if (restored !== null) {
              syncedRef.current = restored;
            } else if (hasFoldingToken(text)) {
              // Fold: re-render every folding run (link, emphasis) as clean HTML.
              decorate(el, text, null, false);
              syncedRef.current = text;
            }
          }}
          // The "/" and "#" menus own Arrow/Enter/Tab/Esc while open; the
          // outline shortcuts above defer via `enabled`. The plugin menus get
          // first crack (the "#" trigger is the more specific), then the slash
          // menu.
          onKeyDown={(e) => {
            if (menus.handleKeyDown(e)) return;
            slash.handleKeyDown(e);
          }}
        />
        {slash.menu}
        {menus.menu}
      </div>

      {hasChildren && (
        <OutlineNodeChildren
          childIds={visibleChildIds}
          collapsed={effectiveCollapsed}
          ancestorCompleted={faded}
          commands={commands}
          pluginCtx={pluginCtx}
          registerRef={registerRef}
          pivotId={pivotId}
          isHidden={isHidden}
          filter={filter}
        />
      )}
    </li>
  );
}

/**
 * The recursive child list for one bullet: the collapse-animation wrapper plus
 * the mapped child `OutlineNode`s. Split out of `OutlineNodeBody` so that body
 * stays focused on the single bullet's own row and behavior, while this piece
 * owns the tree descent. Children stay mounted while collapsed so the
 * reveal/hide can animate (the grid-rows trick needs both states present); the
 * wrapper clamps height to 0 when collapsed, and the editor's visible-order walk
 * skips collapsed subtrees independently, so hidden rows are inert.
 */
function OutlineNodeChildren({
  childIds,
  collapsed,
  ancestorCompleted,
  commands,
  pluginCtx,
  registerRef,
  pivotId,
  isHidden,
  filter,
}: {
  childIds: string[];
  collapsed: boolean;
  ancestorCompleted: boolean;
} & Pick<
  OutlineNodeProps,
  "commands" | "pluginCtx" | "registerRef" | "pivotId" | "isHidden" | "filter"
>) {
  return (
    <div className="outline-children-wrap" data-collapsed={collapsed}>
      <ul className="outline-children" aria-hidden={collapsed}>
        {childIds.map((childId) => (
          <OutlineNode
            key={childId}
            nodeId={childId}
            commands={commands}
            pluginCtx={pluginCtx}
            registerRef={registerRef}
            pivotId={pivotId}
            ancestorCompleted={ancestorCompleted}
            isHidden={isHidden}
            filter={filter}
          />
        ))}
      </ul>
    </div>
  );
}
