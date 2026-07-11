import { type TreeIndex } from "./tree";

/**
 * Tags are parsed out of `node.text` at read time -- never a stored field.
 * `#important` lives literally in the text, the same way an inline `code` run
 * does (see inline-code.ts). Parsing here keeps the data layer the source of
 * truth; the renderer (inline-code.ts) reuses {@link TAG_PATTERN} to decorate
 * the same runs as clickable chips. See ADR 0015.
 *
 * A tag is `#` preceded by start-of-text or whitespace, then one or more
 * letters / numbers / underscore / hyphen, ending at the next space or
 * punctuation. So `#work-q3` and `#важно` match; `foo#bar` and a bare `#` do
 * not. `@`-mentions are deferred (v1 is `#` only).
 */
export const TAG_PATTERN = "(?<=^|\\s)#[\\p{L}\\p{N}_-]+";

const TAG_RE = new RegExp(TAG_PATTERN, "gu");

const EMPTY_TAGS: string[] = [];

/**
 * The distinct tags in a string, with their leading `#`, in first-seen order.
 * Bails before any regex work when `text` can't contain a `#` (the tree-store's
 * incremental corpus maintenance runs this on every text-changing keystroke, not
 * just tag-bearing ones -- same early-out discipline as `parseNodeLinks`).
 */
export function parseTags(text: string): string[] {
  if (!text.includes("#")) return EMPTY_TAGS;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

/** The bare tag name (no leading `#`, lowercased) -- the key tag colors and
 *  case-folded comparisons use. See [[tag-colors]] (src/data/tag-colors.ts). */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").toLowerCase();
}

/** Every distinct tag used anywhere in the outline, sorted -- the autocomplete
 *  corpus. Case-folded dedupe keeps the first-seen casing. */
/**
 * Every distinct tag in the outline, sorted. `excludeId` drops one node's
 * contribution -- the `#` autocomplete passes the node being edited so it offers
 * tags from OTHER nodes and never the brand-new tag you're mid-typing (which is
 * already in the live tree). Without this the menu would match a tag to itself.
 */
export function collectAllTags(index: TreeIndex, excludeId?: string): string[] {
  const seen = new Map<string, string>();
  for (const node of index.byId.values()) {
    if (node.id === excludeId) continue;
    for (const tag of parseTags(node.text)) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * One entry in `TreeIndex.tagCorpus` (tree.ts): `tag` is the display casing
 * (first registered, same first-seen-wins rule `collectAllTags` uses within a
 * single build), `count` is how many nodes currently carry it -- so removing a
 * node's occurrence is a decrement, not a rescan. Built once in `buildTreeIndex`
 * and maintained incrementally in tree-store.ts's `applyChanges`, so the `#`
 * picker's `entries` call is O(distinct tags) instead of O(all nodes) per
 * keystroke while the menu is open.
 */
export interface TagEntry {
  tag: string;
  count: number;
}

/** The maintained corpus's sorted distinct tag list -- the `#` picker's
 *  autocomplete source. O(distinct tags), never O(all nodes). */
export function collectTagCorpus(corpus: Map<string, TagEntry>): string[] {
  const out: string[] = [];
  for (const entry of corpus.values()) out.push(entry.tag);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Typed search params, shared by the home and zoom routes. `focus=last` lands
 *  the caret on the last visible child on load (the daily `/today` redirect). */
export interface OutlineSearch {
  q?: string;
  focus?: "last";
}

export function validateOutlineSearch(
  search: Record<string, unknown>,
): OutlineSearch {
  const q = typeof search.q === "string" ? search.q.trim() : "";
  const out: OutlineSearch = {};
  if (q) out.q = q;
  // Pass `focus=last` through: the router validates the DESTINATION route's
  // search, so any key not returned here is dropped before it reaches the
  // editor (which is why the redirect's ?focus=last was silently a no-op).
  if (search.focus === "last") out.focus = "last";
  return out;
}
