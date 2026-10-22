// The `?q=` query-filter grammar (ADR 0047). A pure, dependency-free parse
// engine: the core owns STRUCTURE (spaces = AND, `-` = NOT, uppercase `OR`,
// `"quotes"`, the `key:value` shape, `#tag`), plugins own MEANING (each operator
// is a predicate a plugin registers via the `filterOperators` seam). This module
// is the `tags.ts`/`highlight.ts` discipline: no DOM, no collection imports, so
// it stays bun-testable; it may lean on other pure `src/data` modules
// (`flattenInline` for free-text matching, `parseTags` for the `#tag` predicate).
//
// The grammar is public once users share `?q=` URLs, so every syntax decision
// here is one-way (ADR 0047 §5) -- `OR` and quoting ship day one rather than
// being retrofitted.

import type { Node, TreeIndex } from "./tree";

import { localDateKey } from "./date-links";
import { flattenInline } from "./inline-text";
import { parseTags } from "./tags";
import { childrenOf, trueSourceOf } from "./tree";
import { rowKeyFor } from "./visible-order";

// --- Operators (the plugin seam's data shape) -------------------------------
//
// A FilterOperator owns a `key` plus the `values` it claims under that key --
// each a `key:value` PAIR (ADR 0047 §4 decision (a): per-value registration, so
// meaning stays with its owner). Registering per-pair is why `is` can be a
// multi-owner key: core owns `is:todo|bullet|paragraph|mirror`, todos owns
// `is:complete`, provenance owns `is:agent` -- three plugins, no collision,
// because the guard is on (key, value), not the bare key. The collision guard
// lives in {@link buildFilterOperatorMap}.

/** The minimal context a dynamic `values` factory reads (autocomplete, a later
 *  slice). Kept tiny on purpose -- an operator's values shouldn't need the whole
 *  PluginContext. */
export interface FilterOperatorContext {
  index: TreeIndex;
}

export interface FilterOperator {
  /** The operator key, e.g. `"is"`, `"has"`, `"highlight"`. Lowercase. */
  key: string;
  /**
   * The values this operator owns under `key`. Each becomes a claimed
   * `key:value` pair (for the collision guard and, later, autocomplete). A
   * function form is allowed for dynamic value sets (tag-like corpora) but is
   * NOT expanded into the lookup map in this slice -- only static arrays are.
   */
  values?:
    | readonly string[]
    | ((ctx: FilterOperatorContext) => readonly string[]);
  /** Also own the BARE `key:` form (no value). Only `highlight:` uses it today
   *  ("any highlight run"). Represented as the (key, null) pair. */
  bare?: boolean;
  /** Paint each value with its color swatch in autocomplete (ADR 0047 §7): a dot
   *  filled with `var(--tag-<value>)`. Set only by `highlight:` today, whose
   *  values (`red`, `blue`, ...) ARE the shared `--tag-*` palette names. A pure
   *  render HINT -- the component reads it, this module stays DOM-free. */
  swatch?: boolean;
  /** One-line description for the autocomplete cheat sheet. Registered so a new
   *  operator shows up in suggestions for free (ADR 0047 §7). */
  description: string;
  /**
   * True iff `node` matches this operator at `value` (null = the bare form). The
   * plugin supplies the meaning; the core only routes the parsed term here.
   */
  predicate: (node: Node, index: TreeIndex, value: string | null) => boolean;
}

/** The (key, value) -> operator lookup the query evaluator consults. Keyed by
 *  {@link pairKey}. */
export type FilterOperatorMap = Map<string, FilterOperator>;

/** The lookup key for an operator (key, value) pair; `null` value = the bare
 *  form. Values are lower-cased at parse time, so this never sees mixed case. */
function pairKey(key: string, value: string | null): string {
  return `${key}:${value ?? ""}`;
}

/**
 * Fold every registered operator into one (key, value) -> operator map, throwing
 * on a duplicate claim -- the load-time guard the keymap seam models (ADR 0001).
 * Two operators may share a KEY (that is the whole point of the seam), but never
 * the same (key, value) PAIR. A static `values` array expands to one entry per
 * value; `bare` adds the (key, null) entry; a function-form `values` claims no
 * static pairs (dynamic, resolved elsewhere -- unused in this slice).
 */
export function buildFilterOperatorMap(
  operators: readonly FilterOperator[],
): FilterOperatorMap {
  const map: FilterOperatorMap = new Map();
  const claim = (key: string, value: string | null, op: FilterOperator) => {
    const k = pairKey(key, value);
    if (map.has(k)) {
      const label = value === null ? `${key}:` : `${key}:${value}`;
      throw new Error(
        `[filterOperators] duplicate operator claim "${label}" -- two plugins own the same key:value pair.`,
      );
    }
    map.set(k, op);
  };
  for (const op of operators) {
    if (op.bare) claim(op.key, null, op);
    if (Array.isArray(op.values)) {
      for (const v of op.values) claim(op.key, v.toLowerCase(), op);
    }
  }
  return map;
}

// --- The parsed query AST ---------------------------------------------------
//
// AND-list of OR-groups (ADR 0047 §5): a node matches iff EVERY group has SOME
// matching term. `some` within a group absorbs `OR`; `every` across groups is
// the space-separated AND. Negation rides on the term.

/** A free-text or quoted-phrase term: case-insensitive substring over
 *  `flattenInline(node.text)`. */
export interface TextTerm {
  type: "text";
  value: string;
  negated: boolean;
}

/** A `#tag` term: EXACT tag equality (case-sensitive Set membership, identical
 *  to the pre-grammar behavior -- ADR 0047 §4 keeps it). */
export interface TagTerm {
  type: "tag";
  tag: string;
  negated: boolean;
}

/** A `key:value` term. Resolved against the operator map at eval time; an
 *  unresolved key/value degrades to a free-text match over `raw` (§2). */
export interface OperatorTerm {
  type: "operator";
  key: string;
  /** Lower-cased value, or null for the bare `key:` form. */
  value: string | null;
  /** The original `key:value` source, for the graceful free-text fallback. */
  raw: string;
  negated: boolean;
}

export type Term = TextTerm | TagTerm | OperatorTerm;

/** A group of OR-ed terms (one or more). */
export interface QueryGroup {
  terms: Term[];
}

/** A parsed query: AND-list of OR-groups. Empty `groups` = no filter. */
export interface FilterQuery {
  groups: QueryGroup[];
}

// --- Tokenizer --------------------------------------------------------------

/**
 * Split a raw query into its SURFACE tokens (re-serializable), respecting
 * quotes: a `"` toggles quote mode so spaces inside a phrase don't end the
 * token. `-"a b"`, `"a b"`, `#tag`, `is:todo`, and `OR` each come back as one
 * token. Also the source of truth for the tag-chip AND-in dedup (so a chip
 * click adds exactly one token and never duplicates an existing one).
 */
export function tokenizeQuery(q: string | undefined): string[] {
  if (!q) return [];
  const out: string[] = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(q[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let inQuote = false;
    while (i < n) {
      const c = q[i]!;
      if (c === '"') {
        inQuote = !inQuote;
        i++;
        continue;
      }
      if (!inQuote && /\s/.test(c)) break;
      i++;
    }
    out.push(q.slice(start, i));
  }
  return out;
}

const TAG_TOKEN_RE = /^#[\p{L}\p{N}_-]+$/u;
const OPERATOR_TOKEN_RE = /^([a-zA-Z]+):(.*)$/;

/** One classified surface token: a real term, an `OR` separator, or a skip
 *  (an empty phrase / bare `-` that contributes nothing). */
type Item = { kind: "term"; term: Term } | { kind: "or" } | { kind: "skip" };

/** Strip a single surrounding pair of quotes (and any interior quote chars) from
 *  a phrase token, yielding the literal phrase text. */
function unquote(s: string): string {
  return s.replace(/"/g, "");
}

function classify(token: string): Item {
  // Uppercase standalone OR (unquoted, no leading dash) is the group connective.
  if (token === "OR") return { kind: "or" };

  let s = token;
  let negated = false;
  if (s.startsWith("-") && s.length > 1) {
    negated = true;
    s = s.slice(1);
  }

  // A quoted phrase escapes OR and operators -- it is always literal text.
  if (s.startsWith('"')) {
    const value = unquote(s);
    if (!value) return { kind: "skip" };
    return { kind: "term", term: { type: "text", value, negated } };
  }

  if (TAG_TOKEN_RE.test(s)) {
    return { kind: "term", term: { type: "tag", tag: s, negated } };
  }

  const m = OPERATOR_TOKEN_RE.exec(s);
  if (m) {
    const key = m[1]!.toLowerCase();
    const rawVal = m[2]!;
    const value = rawVal.length > 0 ? rawVal.toLowerCase() : null;
    return {
      kind: "term",
      term: { type: "operator", key, value, raw: s, negated },
    };
  }

  const value = unquote(s);
  if (!value) return { kind: "skip" };
  return { kind: "term", term: { type: "text", value, negated } };
}

/**
 * Parse a raw `?q=` string into the AND-list of OR-groups. Never throws --
 * malformed input degrades (an unknown operator becomes free text at eval time;
 * a dangling `OR` becomes a literal `OR` text term). Pure and structural: it
 * does NOT consult the operator registry (that is eval's job), so it is the same
 * for every plugin set.
 */
export function parseFilterQuery(q: string | undefined): FilterQuery {
  const items = tokenizeQuery(q).map(classify);
  const groups: QueryGroup[] = [];
  // When the previous item was an `OR` connecting two terms, the next term joins
  // the last group instead of starting a new one.
  let joinNext = false;

  const nextIsTerm = (from: number): boolean => {
    for (let j = from; j < items.length; j++) {
      const it = items[j]!;
      if (it.kind === "skip") continue;
      return it.kind === "term";
    }
    return false;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "skip") continue;
    if (it.kind === "or") {
      // A valid connective needs a group to its left and a term to its right;
      // otherwise it is a dangling `OR` -> literal text (a new group).
      if (groups.length > 0 && nextIsTerm(i + 1)) {
        joinNext = true;
      } else {
        groups.push({ terms: [{ type: "text", value: "OR", negated: false }] });
      }
      continue;
    }
    if (joinNext && groups.length > 0) {
      groups[groups.length - 1]!.terms.push(it.term);
      joinNext = false;
    } else {
      groups.push({ terms: [it.term] });
    }
  }

  return { groups };
}

// --- Evaluation -------------------------------------------------------------

function termMatches(
  term: Term,
  node: Node,
  index: TreeIndex,
  operators: FilterOperatorMap,
  today: string,
): boolean {
  let hit: boolean;
  switch (term.type) {
    case "text":
      hit = flattenInline(node.text, today)
        .toLowerCase()
        .includes(term.value.toLowerCase());
      break;
    case "tag":
      // Exact, case-sensitive Set membership -- identical to the old
      // `matchesAllTags` (ADR 0047 §4 "keep case behavior identical to today").
      hit = parseTags(node.text).includes(term.tag);
      break;
    case "operator": {
      const op = operators.get(pairKey(term.key, term.value));
      hit = op
        ? op.predicate(node, index, term.value)
        : // Graceful degradation: an unknown key/value is just free text (§2).
          flattenInline(node.text, today)
            .toLowerCase()
            .includes(term.raw.toLowerCase());
      break;
    }
  }
  return term.negated ? !hit : hit;
}

/** True iff a content-resolved node satisfies every group. Callers redact the
 * index before resolving agent-facing content (ADR 0063). */
export function nodeMatches(
  query: FilterQuery,
  node: Node,
  index: TreeIndex,
  operators: FilterOperatorMap,
  today = localDateKey(),
): boolean {
  return query.groups.every((g) =>
    g.terms.some((t) => termMatches(t, node, index, operators, today)),
  );
}

/** Content comes from the source; position, collapse, and mirror identity stay
 * on the instance. A missing source keeps the instance's stored fields. */
export function queryNode(
  index: TreeIndex,
  node: Node,
  mirrorsEnabled = true,
): Node {
  if (!mirrorsEnabled || node.mirrorOf === null) return node;
  const source = index.byId.get(trueSourceOf(index, node.id));
  if (!source) return node;
  return {
    ...source,
    id: node.id,
    parentId: node.parentId,
    prevSiblingId: node.prevSiblingId,
    mirrorOf: node.mirrorOf,
    collapsed: node.collapsed,
    bookmarkedAt: node.bookmarkedAt,
  };
}

/** Preorder over the reachable view, with mirror-cycle capping and no recursion.
 * `path` and `ancestorKeys` exclude the current row and are borrowed until the
 * next iteration. Keys follow the renderer's crossed-mirror convention.
 * Search deduplicates both node emissions and source expansion; the app walks
 * every instance path so all contextual ancestors remain visible. */
export function* walkQueryNodes(
  index: TreeIndex,
  rootId: string | null,
  options: {
    includeRoot?: boolean;
    mirrorsEnabled?: boolean;
    isHidden?: (node: Node) => boolean;
    deduplicate?: boolean;
  } = {},
): Generator<{
  node: Node;
  path: readonly Node[];
  key: string;
  ancestorKeys: readonly string[];
}> {
  const mirrorsEnabled = options.mirrorsEnabled ?? true;
  const root = rootId === null ? undefined : index.byId.get(rootId);
  if (rootId !== null && !root) return;
  const rootContentId =
    root && mirrorsEnabled ? trueSourceOf(index, root.id) : rootId;
  const roots =
    root && options.includeRoot ? [root] : childrenOf(index, rootContentId);
  const stack: Array<{ node: Node; prefix: string | null } | { exit: string }> =
    roots.reverse().map((node) => ({ node, prefix: null }));
  const path: Node[] = [];
  const ancestorKeys: string[] = [];
  const expanded = new Set<string>();
  const emitted = new Set<string>();
  const searchedSources = new Set<string>();
  if (root && !options.includeRoot && rootContentId !== null) {
    expanded.add(rootContentId);
    searchedSources.add(rootContentId);
  }
  while (stack.length) {
    const step = stack.pop();
    if (!step) break;
    if ("exit" in step) {
      path.pop();
      ancestorKeys.pop();
      expanded.delete(step.exit);
      continue;
    }
    const node = queryNode(index, step.node, mirrorsEnabled);
    if (options.isHidden?.(node)) continue;
    const contentId = mirrorsEnabled ? trueSourceOf(index, node.id) : node.id;
    const key = rowKeyFor(step.prefix, node.id);
    if (!options.deduplicate || !emitted.has(node.id)) {
      emitted.add(node.id);
      yield { node, path, key, ancestorKeys };
    }
    if (expanded.has(contentId)) continue;
    if (options.deduplicate && searchedSources.has(contentId)) continue;
    searchedSources.add(contentId);
    path.push(node);
    ancestorKeys.push(key);
    expanded.add(contentId);
    stack.push({ exit: contentId });
    const prefix =
      step.prefix !== null || (mirrorsEnabled && node.mirrorOf !== null)
        ? key
        : null;
    for (const child of childrenOf(index, contentId).reverse()) {
      stack.push({ node: child, prefix });
    }
  }
}

/**
 * The visible set for a `?q=` filter, computed at render time from the tree --
 * never mutating a node (in particular `collapsed` is untouched, so clearing the
 * filter restores the exact prior view). Generalizes the old `buildTagFilter`
 * walk (ADR 0015) to the full grammar, with ADR 0047 §8's ONE semantic change:
 *
 * - **Matches + their ancestors** land in `visibleIds`; the match itself in
 *   `matchIds`. Ancestors render as dimmed context. Matches are revealed even
 *   inside a COLLAPSED subtree (the walk ignores collapse to find them) --
 *   today's tag-filter behavior.
 * - **A match's descendants** now render too (§8: "a match reveals its subtree"),
 *   under NORMAL visibility rules -- collapse respected, `isHidden` applied --
 *   and UNDIMMED, so they go into `matchIds` (the row render derives dimming as
 *   `!matchIds.has(rowKey)`, so descendants must be members to stay lit).
 * Both sets contain render keys, not shared descendant node IDs.
 *
 * Returns `null` for an empty/absent query (no filter). `emptyMessage` is set
 * when nothing matches (the editor shows it in place of the list).
 *
 * `isHidden` is the composed Seam-G prune (hide-completed today), so a node
 * absent from the DOM is absent here too. `operators` is the registry-composed
 * (key, value) -> predicate map. `focusedKey` retains the editing row and its
 * ancestor context until blur, without revealing extra descendants.
 */
export function buildQueryFilter(
  index: TreeIndex,
  rootId: string | null,
  query: string | undefined,
  isHidden: (node: Node) => boolean,
  operators: FilterOperatorMap,
  mirrorsEnabled = true,
  focusedKey: string | null = null,
): QueryFilter | null {
  const parsed = parseFilterQuery(query);
  if (parsed.groups.length === 0) return null;

  const visibleIds = new Set<string>();
  const matchIds = new Set<string>();
  const today = localDateKey();

  // Preorder lets an expanded match reveal its children along this exact render
  // path. Independently matching rows still reveal collapsed ancestor context.
  for (const { node, path, key, ancestorKeys } of walkQueryNodes(
    index,
    rootId,
    {
      isHidden,
      mirrorsEnabled,
    },
  )) {
    const parent = path[path.length - 1];
    const parentKey = ancestorKeys[ancestorKeys.length - 1];
    const revealed =
      parent &&
      parentKey !== undefined &&
      !parent.collapsed &&
      matchIds.has(parentKey);
    if (revealed || nodeMatches(parsed, node, index, operators, today)) {
      matchIds.add(key);
      visibleIds.add(key);
      for (const ancestorKey of ancestorKeys) visibleIds.add(ancestorKey);
    }
    // Keep the editing instance reachable even after its text stops matching.
    // Use its render key so other copies of mirrored content still filter live.
    if (key === focusedKey) {
      visibleIds.add(key);
      for (const ancestorKey of ancestorKeys) visibleIds.add(ancestorKey);
    }
  }

  const result: QueryFilter = { visibleIds, matchIds };
  // Keep the editor undimmed without revealing its otherwise-pruned descendants.
  // Adding this after the walk avoids treating focus as a subtree match. Track
  // focus-only retention separately so it cannot expose an expand affordance.
  if (
    focusedKey !== null &&
    visibleIds.has(focusedKey) &&
    !matchIds.has(focusedKey)
  ) {
    result.retainedKey = focusedKey;
    matchIds.add(focusedKey);
  }
  if (matchIds.size === 0) {
    result.emptyMessage = `No matches for "${(query ?? "").trim()}" here.`;
  }
  return result;
}

/**
 * The precomputed visible-set a `?q=` filter produces -- the shape the render
 * path (`buildVisibleRows`, the row's dimming derivation) and the plugin Seam-G
 * `ViewFilter` both consume. Generalizes the old `TagFilter`.
 *
 * These sets store render keys (bare node IDs until a mirror is crossed).
 * - `visibleIds`: every row that renders (matches + ancestor context + a
 *   match's revealed descendants + the focused row and its context).
 * - `matchIds`: the UNDIMMED subset (matches + their descendants + the focused
 *   row); the rest of `visibleIds` (ancestor context) renders dimmed.
 * - `emptyMessage`: shown when nothing matched and no focused row is retained.
 */
export interface QueryFilter {
  visibleIds: Set<string>;
  matchIds: Set<string>;
  /** Undimmed solely for focus, not a match that can reveal more children. */
  retainedKey?: string;
  emptyMessage?: string;
}

// --- Autocomplete (ADR 0047 §7) ---------------------------------------------
//
// The registry-driven suggestions for the filter input. Pure: it consumes the
// operator metadata (folded into {@link OperatorKeyInfo}) plus the tag corpus
// and returns typed rows; the component only maps rows to JSX. "Nothing
// hand-maintained -- a new plugin operator appears in autocomplete for free."
// Scope guard (ADR 0047 §7): suggestions ONLY produce text to insert into a
// plain input -- no inline pill editing, no caret-menu engine, no cmdk.

/** One cheat-sheet KEY, folding every operator that shares that key into one
 *  row: the union of their static values, the description of the first-
 *  registered operator, and whether any of them owns the bare form / paints
 *  swatches. Core is registered first, so `is`'s description is core's. */
export interface OperatorKeyInfo {
  key: string;
  description: string;
  bare: boolean;
  swatch: boolean;
  /** The union of static values across every operator sharing `key`, lower-
   *  cased and deduped, in registration order. Function-form value sets are
   *  skipped (dynamic, resolved elsewhere -- as in the operator map). */
  values: string[];
}

/** Fold the flat operator list into one {@link OperatorKeyInfo} per distinct
 *  key, preserving first-seen key order. Mirrors {@link buildFilterOperatorMap}
 *  (static arrays only) but for suggestions, not the eval lookup. */
export function collectOperatorKeyInfos(
  operators: readonly FilterOperator[],
): OperatorKeyInfo[] {
  const byKey = new Map<string, OperatorKeyInfo>();
  const order: string[] = [];
  for (const op of operators) {
    let info = byKey.get(op.key);
    if (!info) {
      info = {
        key: op.key,
        description: op.description,
        bare: false,
        swatch: false,
        values: [],
      };
      byKey.set(op.key, info);
      order.push(op.key);
    }
    if (op.bare) info.bare = true;
    if (op.swatch) info.swatch = true;
    if (Array.isArray(op.values)) {
      for (const v of op.values) {
        const lv = v.toLowerCase();
        if (!info.values.includes(lv)) info.values.push(lv);
      }
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** The whitespace-delimited chunk of `text` containing the caret (the token
 *  being typed), with its bounds so an insertion can replace exactly it. An
 *  empty token (caret between spaces) yields `start === end === caret`. */
export interface CaretToken {
  token: string;
  start: number;
  end: number;
}

/** Extract the {@link CaretToken} at `caret`. Whitespace-delimited on purpose --
 *  keys, tags, and values never contain spaces, so a quote-aware split is
 *  unnecessary here (a quoted phrase is free text and yields no suggestions). */
export function caretToken(text: string, caret: number): CaretToken {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { token: text.slice(start, end), start, end };
}

/** One autocomplete row. `insert` is the literal text that replaces the caret
 *  token (it carries its own trailing space, or none for a bare key that should
 *  chain into value suggestions). `display` tells the component how to paint it. */
export interface FilterSuggestion {
  /** Stable id (listbox option key + `aria-activedescendant`). */
  id: string;
  /** The text that replaces the caret token on selection. */
  insert: string;
  /** Primary label. */
  label: string;
  /** One-line description (cheat-sheet key rows + the bare `key:` row). */
  description?: string;
  /** How the row renders: a colored `#tag` chip, an operator value, or a
   *  cheat-sheet key. */
  display: "tag" | "value" | "key";
  /** For a swatch-painting value (`highlight:red`): the palette color name,
   *  filled into `var(--tag-<swatch>)`. */
  swatch?: string;
  /** For `display: "tag"`: the bare tag name (no `#`), the `data-tag` key. */
  tag?: string;
}

const TAG_SUGGESTION_CAP = 8;

/**
 * The suggestions for `token` (the caret token, from {@link caretToken}):
 *
 * - `#` / `#partial` -> the tag corpus, case-insensitive substring, capped.
 * - `key:` / `key:partial` -> that key's registered values by prefix (plus the
 *   bare `key:` form for a bare-owning key when no value is typed yet). An
 *   unknown key yields nothing (it degrades to free text at eval time).
 * - empty / a partial key -> the operator cheat sheet (keys by prefix) plus the
 *   `#tag` entry on the empty sheet.
 * - a leading `-` is transparent (suggest for the rest; the `-` rides the
 *   insert), and a `"quoted` phrase yields nothing (it is free text).
 */
export function buildFilterSuggestions(
  token: string,
  keyInfos: readonly OperatorKeyInfo[],
  tags: readonly string[],
): FilterSuggestion[] {
  const neg = token.startsWith("-") ? "-" : "";
  const body = neg ? token.slice(1) : token;

  // A quoted phrase is free text -- no operator/tag suggestions apply.
  if (body.startsWith('"')) return [];

  // Tag corpus mode.
  if (body.startsWith("#")) {
    const partial = body.slice(1).toLowerCase();
    const out: FilterSuggestion[] = [];
    for (const tag of tags) {
      if (out.length >= TAG_SUGGESTION_CAP) break;
      if (partial && !tag.slice(1).toLowerCase().includes(partial)) continue;
      out.push({
        id: `tag:${tag}`,
        insert: `${neg}${tag} `,
        label: tag,
        display: "tag",
        tag: tag.slice(1),
      });
    }
    return out;
  }

  // Value mode: `key:` or `key:partial`.
  const colon = body.indexOf(":");
  if (colon !== -1) {
    const key = body.slice(0, colon).toLowerCase();
    const partial = body.slice(colon + 1).toLowerCase();
    const info = keyInfos.find((k) => k.key === key);
    if (!info) return [];
    const out: FilterSuggestion[] = [];
    // The bare `key:` form (highlight today), offered before a value is typed.
    if (info.bare && partial === "") {
      out.push({
        id: `bare:${key}`,
        insert: `${neg}${key}: `,
        label: `${key}:`,
        description: info.description,
        display: "value",
      });
    }
    for (const v of info.values) {
      if (partial && !v.startsWith(partial)) continue;
      const suggestion: FilterSuggestion = {
        id: `val:${key}:${v}`,
        insert: `${neg}${key}:${v} `,
        label: `${key}:${v}`,
        display: "value",
      };
      if (info.swatch) suggestion.swatch = v;
      out.push(suggestion);
    }
    return out;
  }

  // Cheat sheet: empty token or a partial key.
  const partial = body.toLowerCase();
  const out: FilterSuggestion[] = [];
  for (const info of keyInfos) {
    if (partial && !info.key.startsWith(partial)) continue;
    out.push({
      id: `key:${info.key}`,
      // No trailing space: chain straight into this key's value suggestions.
      insert: `${neg}${info.key}:`,
      label: `${info.key}:`,
      description: info.description,
      display: "key",
    });
  }
  // The `#tag` entry leads into tag-corpus mode; only on the empty sheet (a
  // partial key can't prefix-match it).
  if (partial === "") {
    out.push({
      id: "key:tag",
      insert: `${neg}#`,
      label: "#tag",
      description: "Filter by tag",
      display: "key",
    });
  }
  return out;
}
