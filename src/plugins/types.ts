// The plugin surface (ADR 0001). A plugin is a bundle of registrations against
// the core's finite set of *seams*, compiled into the app (an internal
// registry, D1 -- not runtime-loaded). This file is the typed contract; the
// core composes every plugin's registrations in `registry.ts`.
//
// Seams grow here as features migrate (D4: links -> tags -> todos): A (inline
// token + decorator), B (delegated interaction), I (input/paste); later slices
// add commands, keymap, slots, transforms, menus, and side-collections.

import type { Effect } from "effect";
import type { ComponentType, ReactNode } from "react";
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

/** A JSON-serializable value. Widget props cross the contentEditable's innerHTML
 *  boundary as a JSON string (the core mounts the component LATER, when the
 *  browser upgrades the element), so they must be plain data -- no functions, no
 *  React nodes. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * Seam A (React mode -- ADR 0006): an ATOMIC widget. Unlike an `El` (serialized
 * to an innerHTML string), a widget renders REAL TSX -- a component, lucide
 * icons, Tailwind classes, no plugin CSS. The core serializes it to one custom
 * element that is an opaque atom (`contenteditable="false"` + `data-src`, so the
 * existing caret math jumps over it and `readSource` reads `source`, never the
 * rendered interior), then mounts the token's `component` with `props` when the
 * browser upgrades that element. The chip is non-editable; the caret never
 * enters it. Use a widget for a chip that wants components; `El` stays the fast
 * string path for plain tokens. `widget` is stamped by the core (the token id).
 */
export interface WidgetEl {
  /** Discriminator vs `ElNode`. */
  kind: "widget";
  /** The component key (the token's id). Stamped by the core -- a plugin leaves
   *  it unset. */
  widget?: string;
  /** The atom's SOURCE text -- what `readSource` and the caret math count
   *  (written as `data-src`), and what the component receives as `source`. */
  source: string;
  /** Serializable props handed to the component on mount (as `data-props`).
   *  Omit for a presentational chip whose only input is `source`. */
  props?: Record<string, Json>;
  /** Extra attributes on the atom element -- Seam B interaction hooks like
   *  `data-href`. The core owns `data-src`/`data-src-len`/`data-widget`/
   *  `contenteditable`; don't set those here. */
  attrs?: Record<string, string | number | boolean | undefined>;
}

/** What the core passes a widget's `component`: the atom's `source` text plus
 *  whatever serializable `props` the token's render returned. */
export type WidgetProps = { source: string } & Record<string, Json>;

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
  /**
   * Build the descriptor for one matched token. `tok` is the matched source.
   * Return an `El` (the string fast path) or a `WidgetEl` (a real-TSX atomic
   * widget -- ADR 0006); a token that ever returns a `WidgetEl` must set
   * `component`.
   */
  render(tok: string, view: TokenView): El | WidgetEl;
  /**
   * Seam A (React mode -- ADR 0006): the component the core mounts for a
   * `WidgetEl` this token returns, keyed by the token's `id`. Receives
   * `WidgetProps` (the atom's `source` + the widget's `props`). Required iff
   * `render` can return a `WidgetEl`.
   */
  component?: ComponentType<WidgetProps>;
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
  };
  /** Show (or dismiss, with null) a self-managing overlay -- a portaled popover
   *  the plugin owns (e.g. the tag color picker). A thin generic host: the core
   *  just mounts the node; the overlay handles its own positioning + dismiss. */
  openOverlay: (node: ReactNode | null) => void;
  /** Open (or dismiss, with null) a Tier-3 side PANEL -- the contained host for
   *  rich UI that shouldn't crowd the outline surface (ADR 0031). Unlike
   *  `openOverlay` (a self-positioning popover), the core wraps the node in a
   *  `Sheet`: a slide-in panel with its own backdrop + dismiss. This is where a
   *  node's overflowed decorations expand to, and the only surface a future
   *  Lane-B (untrusted MCP App) may render into. The node must supply its own
   *  `SheetHeader`/`SheetTitle`. */
  openPanel: (node: ReactNode | null) => void;
  /** Run a fire-and-forget async task on the app's shared Effect runtime. The
   *  fiber is tracked and INTERRUPTED when the editor unmounts; any failure or
   *  defect is logged (never silently swallowed, never a floating unhandled
   *  rejection). The effect must be fully provided (R = never) and self-handle
   *  the domain result it cares about — the seam owns the runtime + lifecycle +
   *  failure sink, not error semantics (compose timeout/retry inside the effect,
   *  see kv-client-effect.ts). Editor-lifetime scoped, not node-scoped: deleting
   *  one node does not interrupt an in-flight run (continuation guards cover
   *  that). See ADR 0039. */
  run(effect: Effect.Effect<unknown, unknown>): void;
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
  source?: "pointer" | "keyboard";
  key?: string;
}

export interface PointerInteractionEvent extends InteractionEvent {
  pointerType: string;
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
  /** Handle pointer press/release on the matched element. */
  onPointerDown?: (
    el: HTMLElement,
    ctx: PluginContext,
    e: PointerInteractionEvent,
  ) => void;
  onPointerUp?: (
    el: HTMLElement,
    ctx: PluginContext,
    e: PointerInteractionEvent,
  ) => void;
  onPointerCancel?: (
    el: HTMLElement,
    ctx: PluginContext,
    e: PointerInteractionEvent,
  ) => void;
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
  /** The current route's search params (opaque to the core -- plugins parse). */
  search: Record<string, unknown>;
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
  /** Shown when `matchIds` is empty; plugin-owned copy (the tag filter today). */
  emptyMessage?: string;
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

/** What an `afterPaste` side effect is told once the sync insert has landed: the
 *  exact string that was inserted, the node it landed in (a bullet id, or the
 *  zoomed title's rootId), and the contentEditable element (so a plugin can
 *  decorate the just-inserted DOM -- e.g. a loading affordance on a folded
 *  link). Async follow-up work writes back through `ctx.mutations`. ADR 0016. */
export interface AfterPasteInput {
  inserted: string;
  nodeId: string;
  el: HTMLElement;
}

/** What an autoformat transform is told: the just-typed SOURCE text and the
 *  node it's in (so it can gate on type, e.g. only plain bullets). */
export interface AutoformatInput {
  text: string;
  node: Node;
}

/** The rewrite an autoformat performs. The core writes `text` back to the
 *  store + DOM and places the caret at `caret` (a SOURCE offset); the plugin's
 *  `before` side effect runs first (e.g. flip the bullet to a task) so the type
 *  change lands before the text. */
export interface AutoformatResult {
  text: string;
  caret: number;
  before?(ctx: PluginContext): void;
}

export interface InputSpec {
  /** Decide the replacement string for a paste, or null to defer. */
  onPaste?: (input: PasteInput) => string | null;
  /**
   * Rewrite the text the user just typed -- a markdown-style shortcut like
   * `[]` -> task. Returns null to leave it untouched. The core owns the
   * mechanics (write + decorate + caret); the plugin only decides the new text,
   * caret, and an optional pre-write side effect. First non-null across plugins
   * wins (todos owns the `[]`/`[ ]` task marker).
   */
  autoformat?: (input: AutoformatInput) => AutoformatResult | null;
  /**
   * A side effect fired AFTER a paste's sync insert has landed and re-decorated
   * (ADR 0016). Unlike `onPaste` (pure, returns the string to insert), this may
   * do async work and write back through `ctx.mutations` -- the links plugin
   * uses it to fetch a pasted URL's title and swap it into the label. Every
   * plugin's `afterPaste` runs (array order); each self-gates on whether the
   * inserted string is its own. Keep it cheap when it isn't yours.
   */
  afterPaste?: (input: AfterPasteInput, ctx: PluginContext) => void;
}

// --- Seam C: the `/` command palette ----------------------------------------
//
// A plugin contributes slash commands. The core keeps a small generic set
// (Move); plugin commands concatenate after array order. v1 keeps the bespoke
// `/` engine (useSlashMenu) -- this seam only makes its command LIST
// registry-driven (folding the palette into the menu engine, Seam H, is later).

export interface CommandSpec {
  id: string;
  label: string;
  description: string;
  /** The option's leading icon. Any component taking `className` works (lucide
   *  icons do); the core renders it -- so the type stays icon-library-agnostic. */
  icon: ComponentType<{ className?: string }>;
  /** Extra fuzzy-match terms beyond the label. */
  keywords: string[];
  /** Hide the command for nodes it doesn't apply to (e.g. "To-do" once the
   *  bullet already is a task). */
  available(node: Node): boolean;
  /**
   * Marks a command whose `run` needs a live caret/text-selection inside the
   * bullet (e.g. emphasis wrap). The `/` palette and Seam D still run it (a caret
   * is present there), but the Cmd+K command center EXCLUDES it: opening the
   * overlay steals the caret, so there's nothing to wrap (ADR 0034). Omit for
   * whole-node commands (To-do, Send to Today).
   */
  caretScoped?: boolean;
  /** Run the command against the focused node. */
  run(nodeId: string, ctx: PluginContext): void;
  /**
   * Set-aware variant for node multi-selection (ADR 0018): run against the
   * SELECTED ROOT ids (subtrees implied) in ONE shot. A single-node `run` can't
   * simply be looped over a set -- `Move` would open N destination pickers,
   * daily's "Send to Today" would navigate N times -- so a command must OPT IN
   * by declaring how it batches (`Move` -> one dialog, N moves; todos' To-do ->
   * one batch `setIsTask`; daily's Send to Today -> one batch + one nav). The
   * selection actions menu shows ONLY commands that define this. Multi-node
   * mutations must land as one `runStructural` batch, not a loop of writes
   * (ADR 0009). Omit when the command has no meaningful set semantics.
   */
  runMany?(rootIds: string[], ctx: PluginContext): void;
}

// --- Seam D: per-bullet keymap ----------------------------------------------
//
// A plugin binds a hotkey active while a bullet (or the zoomed title) is
// focused. The core's reserved keys -- Enter, Shift+Enter, Tab, Shift+Tab,
// Backspace, the arrows, the structural moves (Mod+Shift+Arrow, Mod+Arrow) and
// Mod+. -- are off-limits (D7); the registry guards against a collision at load.
// todos owns Mod+Enter and Mod+D (toggle completion).

export interface KeymapSpec {
  id: string;
  /** A @tanstack/react-hotkeys hotkey string, e.g. "Mod+Enter". Must not be a
   *  core-reserved key (the registry warns if it is). */
  hotkey: string;
  /** Run against the focused node. `ctx` reads live tree/commands. */
  run(nodeId: string, ctx: PluginContext): void;
}

// --- Seam F: node render slots ----------------------------------------------
//
// A plugin renders a REAL React node (D10) into a named position decorating a
// node -- the todos checkbox / the daily date badge, before the text. The same
// node renders in TWO paths: a list bullet (`row:`, OutlineNode) and the zoomed
// page title (`title:`, OutlineEditor's ZoomedTitle). A slot opts into either or
// both by registering one spec per position. The core renders whatever the
// matching slots return, in plugin/array order; a slot returns null to
// contribute nothing for a given node (the checkbox only shows on a task).
// Unlike a token (Seam A, El descriptor), a slot is plain JSX.

// `row:bullet` REPLACES the default bullet-dot on list rows (the todos
// checkbox sits in the bullet column so a task is not "dot + checkbox"). The
// core still owns drag on that control; click-to-zoom applies only when the
// default dot is showing (a task's checkbox owns the click to toggle).
// `before-text` slots lead the node (a small leading decoration: the daily
// badge, provenance mark). `after-text` slots trail it -- the budgeted trailing
// decoration zone (ADR 0031): the core caps how much of the bullet they may
// occupy (see NodeDecorations + `--node-deco-budget`), so an author gets any
// component but the outline surface can't be crowded out. Both the row bullet
// and the zoomed title expose before/after-text; `row:bullet` is list-only
// (the zoomed title has no bullet column -- its checkbox stays `title:before-text`).
export type SlotPosition =
  | "row:bullet"
  | "row:before-text"
  | "title:before-text"
  | "row:after-text"
  | "title:after-text";

export interface SlotSpec {
  id: string;
  position: SlotPosition;
  /** Render the slot for `node`, or null to contribute nothing. `getCtx` is the
   *  same stable factory the bullet passes everywhere -- call it inside event
   *  handlers (the checkbox's onCheckedChange), not at render. */
  render(node: Node, getCtx: () => PluginContext): ReactNode;
}

// --- Seam F (header): node-less chrome slots --------------------------------
//
// A row slot (above) decorates a node. A *header* slot places a control in the
// app header -- which has NO focused node -- so it is its own spec whose render
// takes only the PluginContext factory. The core renders every header slot into
// the header's action cluster (plugin/array order). First consumer: the Daily
// Notes plugin's "go to today" button (ADR 0001/0002).

export interface HeaderSlotSpec {
  id: string;
  /** Render the header control. `getCtx` is the same stable PluginContext
   *  factory used everywhere; call it inside handlers (onClick), not at render. */
  render(getCtx: () => PluginContext): ReactNode;
}

// --- Protected nodes --------------------------------------------------------
//
// A plugin marks a node protected (`protects`); the CORE owns what that means
// and enforces every rule uniformly (no delete / blank / to-do / complete) --
// see components/protection.tsx and ADR 0015. So returning a bare `true` is
// enough: the core supplies generic rejection copy. This descriptor only lets a
// plugin OVERRIDE the human-facing details when it cares -- per-action toast copy
// and the canonical name to restore if the node is blanked. Every field is
// optional; the core never depends on the plugin filling them in.

export interface NodeProtection {
  /** General "why" toasted for any rejected action, overriding the core default.
   *  Also the message for a rejected delete specifically. Per-action fields below
   *  override it for their action. */
  reason?: string;
  /** Canonical text restored when the node is emptied -- a protected node can't
   *  be left nameless. Omit for protected nodes with no fixed name (then a blank
   *  is just blocked at the delete/edit level, with nothing to restore). */
  canonicalText?: string;
  /** Override the toast when an emptied node is healed back to `canonicalText`
   *  ("needs a name" vs the general reason). Falls back to `reason`, then the
   *  core default. */
  blankReason?: string;
  /** Override the toast when turning this node into a to-do is rejected. Falls
   *  back to `reason`, then the core default. */
  taskReason?: string;
  /** Override the toast when marking this node done is rejected. Falls back to
   *  `reason`, then the core default. */
  completeReason?: string;
}

// --- Seam F (subheader): contextual chrome below the header -----------------
//
// Header slots are persistent actions (the daily "Today" button). Subheader
// slots are contextual state (the tag filter bar, a future week nav). The core
// renders every non-null slot into one muted band that collapses with animation
// when empty and sticks below the header. v1: render all non-null slots; shared
// row layout (leading/main/trailing regions) is deferred until a second consumer
// ships.

export interface SubheaderSlotSpec {
  id: string;
  /** Return null to contribute nothing. `getCtx` is optional for plugins that
   *  read route state directly (the tag filter); call it inside handlers only. */
  render(getCtx: () => PluginContext): ReactNode;
}

// --- Protected nodes --------------------------------------------------------
//
// A plugin can declare a node protected. The core consults the composed
// predicate on its mutation paths and no-ops on a protected node -- it knows
// "this id is protected", never why. Protection blocks the STRUCTURE-changing
// actions: delete, blank-out (heals on blur), to-do conversion, and completion.
// A protected node is still freely editable, renamable, and can take children.
// First consumer: the Daily Notes plugin's container (ADR 0015).

// --- Seam H: caret autocomplete menus ---------------------------------------
//
// A trigger char ("#", "/") opens a menu at the caret. The core owns the ENGINE
// (detect the trigger before the caret, portal the list, arrow/enter/tab/escape,
// splice the picked replacement into the source); a plugin contributes a
// `MenuSpec` -- the trigger + how to build entries. The `#` tag menu is the
// tags plugin's; the `/` palette folds in with the command registry (Seam C).

/** A live trigger before the caret: the source offset of the trigger char and
 *  the query typed after it. */
export interface MenuTrigger {
  query: string;
  /** Source offset of the trigger char. */
  triggerIndex: number;
}

/**
 * One option in a menu. Fully self-describing: how it renders (a REAL React node
 * -- D10) and what it does when picked. The engine owns the splice: it replaces
 * the `[triggerIndex, triggerIndex + 1 + query.length)` span with `replacement`,
 * places the caret at `triggerIndex + (caret ?? replacement.length)`, then runs
 * `after` (a slash command's mutation). So an entry never touches the DOM.
 */
export interface MenuEntry {
  /** Stable key for the option list. */
  key: string;
  /** The option's inner content (the engine wraps it in the option button). */
  render(active: boolean): ReactNode;
  /** Text that replaces the trigger + query span. */
  replacement: string;
  /** Caret offset WITHIN `replacement` after picking (default: its end). */
  caret?: number;
  /** Side effect after the text edit (e.g. run a slash command). */
  after?(): void;
}

export interface MenuSpec {
  id: string;
  /** The trigger char, e.g. "#" or "/". */
  trigger: string;
  /**
   * Decide whether the trigger is live, given the SOURCE text before the caret.
   * Defaults (when omitted) to: the trigger sits at start-or-after-whitespace
   * and the query after it has no whitespace. Tags override this to require the
   * query be tag-chars (so a `#` mid-punctuation doesn't open).
   */
  match?(before: string): MenuTrigger | null;
  /** Build the option entries for a live trigger. Reads the tree/commands via
   *  `ctx`; `node` is the bullet the caret is in (slash filters by its type). */
  entries(trigger: MenuTrigger, node: Node, ctx: PluginContext): MenuEntry[];
  /** Keep the menu "open" even with zero entries (the `/` palette shows "No
   *  commands"). Default false -- so a brand-new `#tag`'s Enter passes through. */
  openWhenEmpty?: boolean;
  /** Text shown when `openWhenEmpty` and there are no entries. */
  emptyLabel?: string;
}

// --- Seam J: search providers (Cmd+K switcher + /move picker) ---------------
//
// The Fuse-driven pickers match on node text. A plugin can (1) contribute extra
// match TERMS for a real node it recognizes -- the daily plugin maps a node to
// "Today"/"Yesterday" even though its text is a full date -- and (2) contribute
// VIRTUAL rows that run an action on pick (create today's note when it doesn't
// exist yet). Aliases are a pure projection (no ctx); virtual actions get a
// MINIMAL surface (the index + a plain navigate) so the `__root.tsx`-mounted
// switcher needs no PluginContext and plugins import no router types. See ADR
// 0022 (this extends the navigation-only switcher of ADR 0012).

/** The minimal surface a virtual search action gets when picked. */
export interface SearchActionContext {
  /** The live tree index (for get-or-create reads). */
  index: TreeIndex;
  /** Plain navigation to a node's zoom view (no morph -- a result isn't a pivot).
   *  `focus: 'last'` lands the caret on the day's last child on load -- the
   *  write-intent affordance the daily "Go to Today" action needs (ADR 0041). */
  goTo(nodeId: string, opts?: { focus?: "last" }): void;
}

/** A virtual (non-node) row in a search picker -- runs `run` when picked. */
export interface SearchAction {
  /** Stable list key. */
  key: string;
  /** The row's primary label, e.g. "Go to Today". */
  label: string;
  /** Optional secondary line (breadcrumb-style), e.g. "Creates today's note". */
  hint?: string;
  /** Leading icon (a className-taking component, like CommandSpec.icon). */
  icon: ComponentType<{ className?: string }>;
  /** Run on pick: create/resolve a node, then navigate. Self-contained. */
  run(): void;
}

// --- The plugin object ------------------------------------------------------

/**
 * One plugin: a default-exported object registering into whatever seams it
 * needs (D5). Seam keys are added to this interface as features migrate.
 */
export interface PluginDef {
  id: string;
  // NOTE: there is deliberately NO `styles` seam (ADR 0031 retired raw plugin
  // CSS -- a plugin could restyle the whole app through it). A plugin styles its
  // own tokens/slots with Tailwind utility classes on the `El`/JSX it returns
  // (see emphasis's `util`), and dynamic, data-driven sheets (the tag-color
  // generator) stay bespoke `<style>` components keyed on their own data.
  /** Seam A: inline tokens, composed into the one combined regex. */
  tokens?: TokenSpec[];
  /** Seam B: delegated interactions on chips/links in the contentEditable. */
  interactions?: InteractionSpec[];
  /** Seam C: `/` palette commands (todos' `/todo` + `/bullet`). */
  commands?: CommandSpec[];
  /** Seam D: per-bullet hotkeys (todos' Mod+Enter / Mod+D). */
  keymap?: KeymapSpec[];
  /** Seam F: row render slots (the todos checkbox). */
  slots?: SlotSpec[];
  /** Seam F (header): node-less header chrome (the daily "Today" button). */
  headerSlots?: HeaderSlotSpec[];
  /** Seam F (subheader): contextual chrome below the header (the tag filter). */
  subheaderSlots?: SubheaderSlotSpec[];
  /** Protected nodes: mark `nodeId` protected (the daily container is the first
   *  consumer). Return `false` to allow, or `true` / a {@link NodeProtection} to
   *  protect. `true` is enough -- the core enforces every rule (no delete / blank
   *  / to-do / complete) with default copy; the descriptor only OVERRIDES the
   *  copy + canonical name when the plugin cares. Consulted on the delete,
   *  blank-on-blur, to-do, and completion paths (client). */
  protects?(nodeId: string): boolean | NodeProtection;
  /** Subscribe to changes in this plugin's protection state, so a node's lock
   *  affordance can render reactively. A plugin whose `protects` depends on
   *  async/reactive state (e.g. the daily index resolving its container
   *  mapping after fetch) provides this; the core re-evaluates `protects` on
   *  each notification. Returns an unsubscribe. Omit when protection is static
   *  (decidable synchronously, correct at first render). */
  protectsChanged?(cb: () => void): () => void;
  /** Kick off this plugin's async data (a side-collection fetch) eagerly, once,
   *  at editor mount -- client-only and post-auth by construction. A plugin
   *  whose decorations depend on lazily-fetched state (the daily index) provides
   *  this so the fetch races the outline snapshot instead of starting at the
   *  first decorated render and popping in after paint. Idempotent by contract:
   *  the reactive read path may also start the same fetch. */
  preload?(): void;
  /** Seam G: render-time view transforms (hide-completed, the tag filter). */
  viewTransforms?: ViewTransform[];
  /** Seam H: caret autocomplete menus (the `#` tag menu). */
  menus?: MenuSpec[];
  /** Seam I: input transforms (paste + autoformat). */
  input?: InputSpec;
  /** Seam J: extra fuzzy-match terms for a node the plugin recognizes (the
   *  daily plugin's "Today"/"Yesterday" labels, absent from the full-date text).
   *  Matched but not highlighted (the row still displays `node.text`). */
  searchAliases?(node: Node): string[];
  /** Seam J: virtual rows for the Cmd+K switcher, built from the live query;
   *  each runs an action on pick (daily's create-today-if-absent). */
  searchActions?(query: string, ctx: SearchActionContext): SearchAction[];
  /** Seam J: a short, display-only suffix for a node's row in the pickers (the
   *  daily plugin's "Today" relative label), shown parenthesized after the title
   *  so a day note reads "Tuesday, June 23, 2026 (Today)". Never highlighted,
   *  never searched -- pure clarity. First non-null across plugins wins. */
  searchAnnotation?(node: Node): string | null;
}

/** Identity helper -- gives a plugin object its type without a cast (D5). */
export function definePlugin(def: PluginDef): PluginDef {
  return def;
}
