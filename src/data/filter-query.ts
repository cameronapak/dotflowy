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

import { flattenInline } from "./inline-text";
import { parseTags } from "./tags";
import { childrenOf } from "./tree";

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
  /** One-line description for the (future) autocomplete cheat sheet. Registered
   *  now so a new operator shows up in suggestions for free (ADR 0047 §7). */
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
 * token. Also the source of truth for the filter-pill bar's token list (so a
 * removed pill can drop exactly one token and re-join the rest).
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
): boolean {
  let hit: boolean;
  switch (term.type) {
    case "text":
      hit = flattenInline(node.text)
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
          flattenInline(node.text)
            .toLowerCase()
            .includes(term.raw.toLowerCase());
      break;
    }
  }
  return term.negated ? !hit : hit;
}

/** True iff `node` satisfies the whole query: every group has a matching term. */
function nodeMatches(
  query: FilterQuery,
  node: Node,
  index: TreeIndex,
  operators: FilterOperatorMap,
): boolean {
  return query.groups.every((g) =>
    g.terms.some((t) => termMatches(t, node, index, operators)),
  );
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
 *   `!matchIds.has(id)`, so descendants must be members to stay lit).
 *
 * Returns `null` for an empty/absent query (no filter). `emptyMessage` is set
 * when nothing matches (the editor shows it in place of the list).
 *
 * `isHidden` is the composed Seam-G prune (hide-completed today), so a node
 * absent from the DOM is absent here too. `operators` is the registry-composed
 * (key, value) -> predicate map.
 */
export function buildQueryFilter(
  index: TreeIndex,
  rootId: string | null,
  query: string | undefined,
  isHidden: (node: Node) => boolean,
  operators: FilterOperatorMap,
): QueryFilter | null {
  const parsed = parseFilterQuery(query);
  if (parsed.groups.length === 0) return null;

  const visibleIds = new Set<string>();
  const matchIds = new Set<string>();
  const matched: Node[] = [];

  // Pass 1: find every match, ignoring collapse (a match inside a closed subtree
  // is still revealed). Add each match + its ancestors up to (not including) the
  // root -- the ancestors are the dimmed context showing WHERE a match lives.
  const findMatches = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
      if (isHidden(child)) continue;
      if (nodeMatches(parsed, child, index, operators)) {
        matchIds.add(child.id);
        matched.push(child);
        let cur: Node | undefined = child;
        while (cur && cur.id !== rootId) {
          visibleIds.add(cur.id);
          cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
        }
      }
      findMatches(child.id);
    }
  };
  findMatches(rootId);

  // Pass 2 (ADR 0047 §8): reveal each match's descendants under NORMAL rules --
  // collapse respected (a collapsed match shows no children; toggling it
  // recomputes), `isHidden` applied -- and undimmed (into `matchIds`). Emission
  // stays gated on `visibleIds` in `buildVisibleRows`, whose filter-mode walk
  // force-descends; adding only the collapse-respecting descendants here is what
  // keeps a collapsed match's subtree hidden without mutating `collapsed`.
  const revealSubtree = (node: Node) => {
    if (node.collapsed) return;
    for (const child of childrenOf(index, node.id)) {
      if (isHidden(child)) continue;
      visibleIds.add(child.id);
      matchIds.add(child.id);
      revealSubtree(child);
    }
  };
  for (const m of matched) revealSubtree(m);

  const result: QueryFilter = { visibleIds, matchIds };
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
 * - `visibleIds`: every node that renders (matches + ancestor context + a
 *   match's revealed descendants).
 * - `matchIds`: the UNDIMMED subset (matches + their descendants); the rest of
 *   `visibleIds` (ancestor context) renders dimmed.
 * - `emptyMessage`: shown when nothing matched.
 */
export interface QueryFilter {
  visibleIds: Set<string>;
  matchIds: Set<string>;
  emptyMessage?: string;
}
