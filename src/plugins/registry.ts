// Seam aggregation (ADR 0018). Derives the combined token machinery from the
// explicit plugins array once, at module load (plugins are compiled in -- D1 --
// so nothing changes at runtime). The core (inline-code.ts) consumes the
// combined regex + dispatch from here, staying generic over which plugins
// exist; this file is the only place that knows the plugin set for tokens.

import { useEffect, useState } from "react";
import { plugins } from "./index";
import { registerWidget } from "../components/plugin-widget";
import type { Node, TreeIndex } from "../data/tree";
import type {
  AutoformatInput,
  AutoformatResult,
  CommandSpec,
  El,
  HeaderSlotSpec,
  SubheaderSlotSpec,
  InteractionEvent,
  KeymapSpec,
  MenuSpec,
  NodeProtection,
  PasteInput,
  PluginContext,
  SearchAction,
  SearchActionContext,
  SlotPosition,
  SlotSpec,
  TokenSpec,
  TokenView,
  ViewContext,
  ViewFilter,
  ViewTransform,
  WidgetEl,
} from "./types";

// --- Plugin styles seam ----------------------------------------------------

/**
 * Every plugin's own CSS, concatenated in array order. The core mounts this once
 * via `<PluginStyles>` (a React 19 hoisted `<style>`) so a plugin keeps its
 * styling in its folder, not core `styles.css`. Empty string when no plugin
 * contributes styles. Namespacing is by each plugin's selector prefix
 * (convention), not Shadow-DOM isolation (impossible for inline tokens).
 */
export const pluginStyles: string = plugins
  .map((p) => p.styles)
  .filter((s): s is string => !!s)
  .join("\n");

// --- Seam A: composed tokens -----------------------------------------------

// Every plugin's tokens, flattened in array order then sorted by precedence.
// Array.prototype.sort is stable, so equal precedences keep plugin/array order
// (D7's tiebreak).
const withOrder: { spec: TokenSpec; order: number }[] = [];
for (const p of plugins) {
  for (const spec of (p.tokens ?? [])) {
    withOrder.push({ spec, order: withOrder.length });
  }
}
const tokenSpecs: TokenSpec[] = withOrder
  .sort((a, b) => a.spec.precedence - b.spec.precedence || a.order - b.order)
  .map(({ spec }) => spec);

// Seam A (React mode -- ADR 0028): register each widget token's component with
// the custom-element host, keyed by the token id (the `data-widget` value the
// serializer stamps). Importing plugin-widget here also runs its client-only
// `customElements.define` side effect (no-op in the prerender). Done once at
// load, in the same pass that builds the token regex.
for (const spec of tokenSpecs) {
  if (spec.component) registerWidget(spec.id, spec.component);
}

// Each fragment goes in its own named group (`_t0`, `_t1`, ...) so a match can
// be dispatched back to the spec that produced it -- robust even if a fragment
// has internal capture groups. One combined `gu` regex => one matchAll pass,
// preserving the per-node hot path (D6). Empty set => a regex that never
// matches, so a plugin-less core simply renders escaped plain text.
const combined =
  tokenSpecs.map((spec, i) => `(?<_t${i}>${spec.pattern})`).join("|") ||
  "(?!)";

/** The one combined token regex (links | code | tags | ...). Global + unicode. */
export const tokenRegex = new RegExp(combined, "gu");

/** Map a combined-regex match back to the spec whose named group matched. */
function specForMatch(m: RegExpMatchArray): TokenSpec | null {
  const groups = m.groups;
  if (!groups) return null;
  for (let i = 0; i < tokenSpecs.length; i++) {
    if (groups[`_t${i}`] !== undefined) return tokenSpecs[i]!;
  }
  return null;
}

/** Render one matched token to its descriptor, dispatching to its plugin. A
 *  widget result is stamped with the token id (its component key) so the
 *  serializer can address the right `<dotflowy-widget>` component (ADR 0028). */
export function renderToken(
  m: RegExpMatchArray,
  view: TokenView,
): El | WidgetEl {
  const spec = specForMatch(m);
  // Should never miss (every match comes from some group), but fall back to the
  // raw source as plain text rather than throw on the hot path.
  if (!spec) return m[0];
  const r = spec.render(m[0], view);
  if (typeof r === "object" && (r as WidgetEl).kind === "widget") {
    (r as WidgetEl).widget = spec.id;
  }
  return r;
}

// A regex matching only the FOLDING tokens (links today), or one that never
// matches when none fold. Drives inline-code's "could the caret reveal anything
// on this line" fast path -- generically, not link-coupled.
const folding = tokenSpecs.filter((s) => s.folds);
const foldingRegex = new RegExp(
  folding.map((s) => s.pattern).join("|") || "(?!)",
  "u",
);

/** True iff the line contains at least one folding token (a link today). */
export function hasFoldingToken(text: string): boolean {
  return folding.length > 0 && foldingRegex.test(text);
}

// --- Seam B: delegated interactions ----------------------------------------

const interactionSpecs = plugins.flatMap((p) => p.interactions ?? []);

/** True iff `target` sits inside any "block the caret" interaction surface --
 *  the core preventDefaults the mousedown so a chip/link click never places a
 *  caret. */
export function blocksCaret(target: HTMLElement): boolean {
  return interactionSpecs.some(
    (s) => s.blockCaretOnMouseDown && target.closest(s.selector),
  );
}

/** Dispatch a click to the first plugin interaction whose selector matches an
 *  ancestor of `target`. Returns true if one handled it. */
export function dispatchClick(
  target: HTMLElement,
  ctx: PluginContext,
  e: InteractionEvent,
): boolean {
  for (const s of interactionSpecs) {
    if (!s.onClick) continue;
    const el = target.closest(s.selector);
    if (el) {
      s.onClick(el as HTMLElement, ctx, e);
      return true;
    }
  }
  return false;
}

/** Dispatch a context-menu (right-click) to the first matching interaction. */
export function dispatchContextMenu(
  target: HTMLElement,
  ctx: PluginContext,
  e: InteractionEvent,
): boolean {
  for (const s of interactionSpecs) {
    if (!s.onContextMenu) continue;
    const el = target.closest(s.selector);
    if (el) {
      s.onContextMenu(el as HTMLElement, ctx, e);
      return true;
    }
  }
  return false;
}

// --- Seam G: composed view transforms --------------------------------------

const viewTransforms: ViewTransform[] = plugins.flatMap(
  (p) => p.viewTransforms ?? [],
);

const hidePredicates = viewTransforms
  .map((t) => t.hidesNode)
  .filter((f): f is NonNullable<typeof f> => f != null);

/**
 * Compose every plugin's `hidesNode` into ONE per-node predicate (a node is
 * hidden iff any transform hides it). The caller memoizes the returned function
 * on `ctx`'s fields so it stays referentially stable across keystrokes -- that
 * stability is what keeps `useVisibleChildIds`'s cache warm (ADR 0014). With no
 * hide transforms, returns a constant "nothing hidden".
 */
export function composeHidden(ctx: ViewContext): (node: Node) => boolean {
  if (hidePredicates.length === 0) return () => false;
  return (node) => hidePredicates.some((p) => p(node, ctx));
}

/**
 * Run the global `buildFilter` transforms; the first non-null result wins (only
 * the tag filter contributes one today). Passes the already-composed `isHidden`
 * so a filter prunes hidden nodes without re-deriving completion.
 */
export function buildViewFilter(
  index: TreeIndex,
  ctx: ViewContext,
  isHidden: (node: Node) => boolean,
): ViewFilter | null {
  for (const t of viewTransforms) {
    const f = t.buildFilter?.(index, ctx, isHidden);
    if (f) return f;
  }
  return null;
}

// --- Seam H: caret autocomplete menus --------------------------------------

/** Every plugin's caret menus, in array order. The engine (menu-engine.tsx)
 *  detects whichever trigger is live before the caret and drives it. */
export const menuSpecs: MenuSpec[] = plugins.flatMap((p) => p.menus ?? []);

// --- Seam I: paste input transforms ----------------------------------------

const inputSpecs = plugins.map((p) => p.input).filter((i) => i != null);

/** Ask each plugin (array order) what to insert for a paste; first non-null
 *  wins. Null => the core falls back to its plain-text default. */
export function pasteReplacement(input: PasteInput): string | null {
  for (const spec of inputSpecs) {
    const r = spec!.onPaste?.(input);
    if (r != null) return r;
  }
  return null;
}

/** Ask each plugin (array order) to rewrite the just-typed text; first non-null
 *  wins. Null => no autoformat applies and the core takes its normal path. */
export function autoformat(input: AutoformatInput): AutoformatResult | null {
  for (const spec of inputSpecs) {
    const r = spec!.autoformat?.(input);
    if (r != null) return r;
  }
  return null;
}

// --- Seam C: the `/` command palette ---------------------------------------

/** Every plugin's slash commands, in array order. The core's bespoke `/` engine
 *  (useSlashMenu) concatenates these after its own generic commands (Move). */
export const commandSpecs: CommandSpec[] = plugins.flatMap(
  (p) => p.commands ?? [],
);

// --- Seam D: per-bullet keymap ---------------------------------------------

/** Every plugin's per-bullet hotkeys, in array order. Wired into the bullet AND
 *  the zoomed title (both register the same way), so a binding works wherever a
 *  node is focused. */
export const keymapSpecs: KeymapSpec[] = plugins.flatMap((p) => p.keymap ?? []);

// D7 reserved-key denylist: keys the core owns on a focused bullet. A plugin
// keymap must not bind these or the core handler would never fire. A load-time
// guard catches the collision (console.error, not throw -- a throw would break
// the prerender build). Cheap and always-on; in a correct build it's silent.
const RESERVED_KEYS = new Set([
  "Enter",
  "Shift+Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Mod+Shift+ArrowUp",
  "Mod+Shift+ArrowDown",
  "Mod+ArrowUp",
  "Mod+ArrowDown",
  "Mod+.",
]);
for (const k of keymapSpecs) {
  if (RESERVED_KEYS.has(k.hotkey)) {
    console.error(
      `[plugins] keymap "${k.id}" binds reserved key "${k.hotkey}" -- the core owns it; the binding will be shadowed.`,
    );
  }
}

// --- Seam F: row render slots ----------------------------------------------

const slotSpecs: SlotSpec[] = plugins.flatMap((p) => p.slots ?? []);

// Group slots by position once, so the per-render lookup returns a STABLE array
// (a fresh filter() each render would be a changing prop on the memoized
// OutlineNode -- ADR 0014). An empty position shares one frozen array.
const EMPTY_SLOTS: readonly SlotSpec[] = Object.freeze([]);
const slotsByPosition = new Map<SlotPosition, SlotSpec[]>();
for (const s of slotSpecs) {
  const arr = slotsByPosition.get(s.position);
  if (arr) arr.push(s);
  else slotsByPosition.set(s.position, [s]);
}

/** The row slots registered at `position`, in plugin/array order. Returns a
 *  referentially stable array (precomputed), safe to read on the hot path. */
export function rowSlots(position: SlotPosition): readonly SlotSpec[] {
  return slotsByPosition.get(position) ?? EMPTY_SLOTS;
}

// --- Seam F (header): node-less chrome slots --------------------------------

/** Every plugin's header slots, in array order. The core renders these into the
 *  header's action cluster (the daily "Today" button). */
export const headerSlots: HeaderSlotSpec[] = plugins.flatMap(
  (p) => p.headerSlots ?? [],
);

// --- Seam F (subheader): contextual chrome below the header -----------------

/** Every plugin's subheader slots, in array order. The core renders non-null
 *  results into one collapsible muted band below the header. */
export const subheaderSlots: SubheaderSlotSpec[] = plugins.flatMap(
  (p) => p.subheaderSlots ?? [],
);

// --- Protected nodes --------------------------------------------------------

const protectPredicates = plugins
  .map((p) => p.protects)
  .filter((f): f is NonNullable<typeof f> => f != null);

/** The protection on `nodeId`, or null if no plugin protects it. The first
 *  matching plugin wins (load order); a bare `true` normalizes to an empty
 *  descriptor (the core's default copy then carries every message). The
 *  enforcement lives in `components/protection.tsx` (`guardProtected` on the
 *  delete / to-do / complete command paths, `signalRejection` on the blur heal)
 *  and the lock render reads {@link isProtected}; this just resolves the
 *  descriptor. The plugin authors only the overrides it cares about. ADR 0015. */
export function getProtection(nodeId: string): NodeProtection | null {
  for (const p of protectPredicates) {
    const r = p(nodeId);
    if (r) return r === true ? {} : r;
  }
  return null;
}

/** True iff any plugin protects `nodeId` from deletion. Event-time read (delete,
 *  blur heal, set-task). The row render uses {@link useIsProtected} so the lock
 *  tracks async protection state. */
export function isProtected(nodeId: string): boolean {
  return getProtection(nodeId) !== null;
}

// Every plugin that can change its protection state asynchronously (array
// order). A plugin whose protection is static (decidable at first render)
// provides none, and never perturbs `useIsProtected`.
const protectSubscribers = plugins
  .map((p) => p.protectsChanged)
  .filter((f): f is NonNullable<typeof f> => f != null);

/** Fan-in over every plugin's `protectsChanged`; one notify -> the caller
 *  re-evaluates protection. Module-level (referentially stable) so it's safe as
 *  a `useSyncExternalStore` subscribe. */
function subscribeProtection(onChange: () => void): () => void {
  const unsubs = protectSubscribers.map((sub) => sub(onChange));
  return () => {
    for (const u of unsubs) u();
  };
}

/** Reactive {@link isProtected}: re-renders the caller when any plugin's
 *  protection state changes (e.g. the daily index resolving its container
 *  mapping after fetch). Use this in render; without it a node's lock only
 *  re-evaluates on an unrelated re-render.
 *
 *  The live read (`isProtected` -> a plugin's collection accessor) runs in an
 *  effect, never in render: touching a lazy collection during render would
 *  start its sync mid-render (a setState-in-render warning). Starts `false`
 *  (prerender-safe, like `useDailyDate`) and resolves post-mount. */
export function useIsProtected(nodeId: string): boolean {
  const [protectedNode, setProtectedNode] = useState(false);
  useEffect(() => {
    const update = () => setProtectedNode(isProtected(nodeId));
    const unsubscribe = subscribeProtection(update);
    update();
    return unsubscribe;
  }, [nodeId]);
  return protectedNode;
}

// --- Seam J: search providers ----------------------------------------------

const aliasProviders = plugins
  .map((p) => p.searchAliases)
  .filter((f): f is NonNullable<typeof f> => f != null);

const actionProviders = plugins
  .map((p) => p.searchActions)
  .filter((f): f is NonNullable<typeof f> => f != null);

const annotationProviders = plugins
  .map((p) => p.searchAnnotation)
  .filter((f): f is NonNullable<typeof f> => f != null);

/** Extra fuzzy-match terms for `node`, contributed by plugins that recognize it
 *  (the daily plugin's relative date label). Empty for an ordinary node. The
 *  pickers key Fuse on these but never highlight them -- the row still displays
 *  `node.text`. */
export function searchAliases(node: Node): string[] {
  if (aliasProviders.length === 0) return [];
  return aliasProviders.flatMap((fn) => fn(node));
}

/** Virtual (non-node) rows for the Cmd+K switcher, built from the live query.
 *  Each runs an action on pick (daily's create-today-if-absent). Composed across
 *  plugins in array order. */
export function searchActions(
  query: string,
  ctx: SearchActionContext,
): SearchAction[] {
  if (actionProviders.length === 0) return [];
  return actionProviders.flatMap((fn) => fn(query, ctx));
}

/** A short display-only suffix for `node`'s picker row (the daily plugin's
 *  relative "Today" label), or null. First non-null wins, in array order --
 *  shown parenthesized after the title, never searched or highlighted. */
export function searchAnnotation(node: Node): string | null {
  for (const fn of annotationProviders) {
    const a = fn(node);
    if (a) return a;
  }
  return null;
}
