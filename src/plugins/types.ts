// The plugin surface (ADR 0018). A plugin is a bundle of registrations against
// the core's finite set of *seams*, compiled into the app (an internal
// registry, D1 -- not runtime-loaded). This file is the typed contract; the
// core composes every plugin's registrations in `registry.ts`.
//
// Seams grow here as features migrate (D4: links -> tags -> todos): A (inline
// token + decorator), B (delegated interaction), I (input/paste); later slices
// add commands, keymap, slots, transforms, menus, and side-collections.

import type { ReactNode } from "react";
import type { Node, TreeIndex } from "../data/tree";
// Type-only (erased at runtime) -- PluginContext.mutations IS the promoted
// NodeCommands (D8), so we reference its type without a runtime import cycle.
import type { NodeCommands } from "../components/OutlineNode";

// --- Seam A: inline token + decorator (D6) ---------------------------------
//
// A token plugin contributes a regex SOURCE FRAGMENT (not a standalone RegExp)
// and a `render` that returns a declarative element descriptor, never an HTML
// string. The core composes all fragments into ONE combined regex (one
// `matchAll` pass, preserving the per-node hot path) and owns escaping +
// serialization -- so a plugin can never hand the core raw HTML (D3/D6/D10).

/**
 * A declarative element descriptor -- the tiny hyperscript a token `render`
 * returns (D6/D10). The core escapes text children and serializes attributes
 * into the contentEditable's innerHTML string. NEVER raw HTML.
 *
 * - a `string` child is plain text (the core HTML-escapes it)
 * - `attrs` values: `true` -> bare boolean attribute; `false`/`undefined` ->
 *   omitted; string/number -> `name="escaped-value"` (insertion order preserved)
 *
 * A *folding* token (a link) emits one atomic element carrying its full source
 * in `data-src` (+ `data-src-len`) and `contenteditable="false"`; the caret
 * machinery counts it generically off `data-src`, with no per-token special
 * casing.
 */
export type El = string | ElNode;

export interface ElNode {
  tag: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  children?: El[];
}

/**
 * What a token `render` is told about the line being decorated. `revealOffset`
 * is the caret's SOURCE offset (null when the bullet is blurred); `start`/`end`
 * are the match's source offsets. A folding token reveals raw vs folds by
 * testing whether the caret sits within `[start, end]`.
 */
export interface TokenView {
  revealOffset: number | null;
  start: number;
  end: number;
}

export interface TokenSpec {
  /** Stable id, for debugging and conflict messages. */
  id: string;
  /**
   * A regex SOURCE fragment (a string), unicode-valid (the combined regex runs
   * with the `u` flag). No outer capturing group -- the core wraps each
   * fragment in its own named group for dispatch. Internal groups are allowed.
   */
  pattern: string;
  /**
   * Orders the alternation branch (lower = matched first on an overlapping
   * span). Today: links 0, code 10, tags 20 -- so a link's interior stays
   * opaque and a `#tag` inside a `code` run stays code. Ties break by plugin
   * array order (D7).
   */
  precedence: number;
  /**
   * True iff this token's display length can differ from its source (it folds,
   * like a link). Drives the core's "should the caret reveal anything here"
   * fast path; non-folding tokens (code/tags, source == display) leave it off.
   */
  folds?: boolean;
  /** Build the descriptor for one matched token. `tok` is the matched source. */
  render(tok: string, view: TokenView): El;
}

// --- PluginContext (D8) -----------------------------------------------------
//
// The promoted, frozen NodeCommands plus read access to the tree and a small
// navigation surface. A plugin's interaction / command handlers receive this;
// new capabilities are added here deliberately, versioned with the surface.

export interface PluginContext {
  /** The live tree index (read-only use; mutate via `mutations`). */
  tree: TreeIndex;
  /** The promoted command set (D8) -- mutations + focus, already stable. */
  mutations: NodeCommands;
  /** A small navigation surface over the URL-driven view. */
  nav: {
    /** Zoom a node to the temporary root. */
    zoom: (id: string) => void;
    /** AND a `#tag` into the active filter (accretes, never replaces). */
    filterTag: (tag: string) => void;
    /** Replace the active tag filter wholesale. */
    setSearch: (tags: string[]) => void;
  };
  /** The active tag filter (the parsed `?q=`), read-only. */
  search: string[];
  /** Show (or dismiss, with null) a self-managing overlay -- a portaled popover
   *  the plugin owns (e.g. the tag color picker). A thin generic host: the core
   *  just mounts the node; the overlay handles its own positioning + dismiss. */
  openOverlay: (node: ReactNode | null) => void;
}

// --- Seam B: delegated interaction ------------------------------------------
//
// Chips/links live inside the contentEditable, so the core runs ONE set of
// delegated handlers on the content container and dispatches to whichever
// plugin owns the surface under the pointer (matched by `selector` via
// target.closest, first match in plugin array order wins).

/** The slice of a DOM mouse event a plugin interaction needs (React's
 *  MouseEvent satisfies this structurally, so the core can pass it straight). */
export interface InteractionEvent {
  preventDefault(): void;
  stopPropagation(): void;
  clientX: number;
  clientY: number;
}

export interface InteractionSpec {
  /** CSS selector for this plugin's interactive surface (e.g. `a[data-link]`,
   *  `.tag[data-tag]`). Matched with target.closest(selector). */
  selector: string;
  /** Block the editing caret on mousedown (so a chip/link click doesn't place a
   *  caret). The core preventDefaults the mousedown when the target matches. */
  blockCaretOnMouseDown?: boolean;
  /** Handle a click on the matched element (the element, not the raw target). */
  onClick?: (el: HTMLElement, ctx: PluginContext, e: InteractionEvent) => void;
  /** Handle a right-click / context menu on the matched element. */
  onContextMenu?: (
    el: HTMLElement,
    ctx: PluginContext,
    e: InteractionEvent,
  ) => void;
}

// --- Seam G: render-time view transforms ------------------------------------
//
// The render-time tree prune (hide-completed, the tag `?q=` filter). Two shapes,
// matching the two that genuinely exist (D9): a *cheap per-node predicate*
// applied during the children walk (hide-completed), and an *optional global
// precompute* that needs whole-tree context to prune to a subtree + mark dimmed
// ancestor context (the tag filter). The core composes both and stops
// special-casing `completed`; completion-hiding and tag-filtering converge on
// this one mechanism.

/**
 * The generic params bag a view transform reads. The core assembles it from app
 * state and hands it over without branching on any field -- so the core no
 * longer "knows" about completion or tags, it just carries data into the pipe.
 */
export interface ViewContext {
  /** Whether completed bullets are shown (the todo plugin's hide transform). */
  showCompleted: boolean;
  /** The active tag filter (parsed `?q=`) -- the same array as the tag plugin's
   *  filter transform reads. */
  search: string[];
  /** The current zoom root, or null at the top. */
  rootId: string | null;
}

/**
 * A precomputed visible-set for a global view transform (the tag filter today).
 * `visibleIds`: nodes that render (matches + their ancestor context).
 * `matchIds`: the subset rendered as real matches; the rest are dimmed context.
 */
export interface ViewFilter {
  visibleIds: Set<string>;
  matchIds: Set<string>;
}

export interface ViewTransform {
  /** Stable id, for debugging. */
  id: string;
  /**
   * A cheap, pure per-node prune applied during the `childrenOf` walk in
   * `useVisibleChildIds` (a hidden node takes its whole subtree with it). The
   * core ORs every transform's `hidesNode` into one predicate. Hot path -- keep
   * it allocation-free. Omit if this transform has no per-node prune.
   */
  hidesNode?(node: Node, ctx: ViewContext): boolean;
  /**
   * A global precompute that needs whole-tree context (the tag filter walks to
   * mark ancestors of matches). Built once per view, not per parent. Receives
   * the already-composed `isHidden` predicate so it can skip pruned nodes
   * WITHOUT re-deriving completion -- cross-transform coupling stays generic.
   * Return null to contribute no filter. First non-null across plugins wins.
   */
  buildFilter?(
    index: TreeIndex,
    ctx: ViewContext,
    isHidden: (node: Node) => boolean,
  ): ViewFilter | null;
}

// --- Seam I: input transforms (paste) ---------------------------------------
//
// The core owns the paste mechanics (always preventDefault, read source +
// selection, splice, re-decorate, place caret) and the plain-text baseline;
// a plugin only decides WHAT string to insert. First plugin to return non-null
// wins; null defers to the next (and finally the core default).

export interface PasteInput {
  /** Clipboard `text/plain`. */
  plain: string;
  /** Clipboard `text/html` (may be ""). */
  html: string;
  /** The selected source text being replaced ("" when the caret is collapsed). */
  selectedText: string;
  /** Whether there is a non-empty selection. */
  hasSelection: boolean;
}

export interface InputSpec {
  /** Decide the replacement string for a paste, or null to defer. */
  onPaste?: (input: PasteInput) => string | null;
}

// --- The plugin object ------------------------------------------------------

/**
 * One plugin: a default-exported object registering into whatever seams it
 * needs (D5). Seam keys are added to this interface as features migrate.
 */
export interface PluginDef {
  id: string;
  /** Seam A: inline tokens, composed into the one combined regex. */
  tokens?: TokenSpec[];
  /** Seam B: delegated interactions on chips/links in the contentEditable. */
  interactions?: InteractionSpec[];
  /** Seam G: render-time view transforms (hide-completed, the tag filter). */
  viewTransforms?: ViewTransform[];
  /** Seam I: input transforms (paste). */
  input?: InputSpec;
}

/** Identity helper -- gives a plugin object its type without a cast (D5). */
export function definePlugin(def: PluginDef): PluginDef {
  return def;
}
