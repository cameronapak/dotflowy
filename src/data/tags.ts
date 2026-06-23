import { childrenOf, type Node, type TreeIndex } from './tree'

/**
 * Tags are parsed out of `node.text` at read time -- never a stored field.
 * `#important` lives literally in the text, the same way an inline `code` run
 * does (see inline-code.ts). Parsing here keeps the data layer the source of
 * truth; the renderer (inline-code.ts) reuses {@link TAG_PATTERN} to decorate
 * the same runs as clickable chips. See docs/adr/0015.
 *
 * A tag is `#` preceded by start-of-text or whitespace, then one or more
 * letters / numbers / underscore / hyphen, ending at the next space or
 * punctuation. So `#work-q3` and `#важно` match; `foo#bar` and a bare `#` do
 * not. `@`-mentions are deferred (v1 is `#` only).
 */
export const TAG_PATTERN = '(?<=^|\\s)#[\\p{L}\\p{N}_-]+'

const TAG_RE = new RegExp(TAG_PATTERN, 'gu')

/** The distinct tags in a string, with their leading `#`, in first-seen order. */
export function parseTags(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(TAG_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0])
      out.push(m[0])
    }
  }
  return out
}

/**
 * The active tags carried in the `q` search param: a space-separated list of
 * `#tag` tokens. Distinct, in order, only well-formed `#...` tokens kept (v1 is
 * tags-only -- any free text in `q` is ignored).
 */
export function parseQuery(q: string | undefined): string[] {
  if (!q) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const tok of q.trim().split(/\s+/)) {
    if (tok.length > 1 && tok.startsWith('#') && !seen.has(tok)) {
      seen.add(tok)
      out.push(tok)
    }
  }
  return out
}

/** Serialize active tags back into the `q` param value. */
export function serializeQuery(tags: string[]): string {
  return tags.join(' ')
}

/** The bare tag name (no leading `#`, lowercased) -- the key tag colors and
 *  case-folded comparisons use. See [[tag-colors]] (src/data/tag-colors.ts). */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').toLowerCase()
}

/** Every distinct tag used anywhere in the outline, sorted -- the autocomplete
 *  corpus. Case-folded dedupe keeps the first-seen casing. */
export function collectAllTags(index: TreeIndex): string[] {
  const seen = new Map<string, string>()
  for (const node of index.byId.values()) {
    for (const tag of parseTags(node.text)) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** True iff `text` carries every one of `activeTags` (per-node AND). */
export function matchesAllTags(text: string, activeTags: string[]): boolean {
  if (activeTags.length === 0) return false
  const tags = new Set(parseTags(text))
  return activeTags.every((t) => tags.has(t))
}

/**
 * The visible set for a tag filter, computed at render time from the tree --
 * never mutating any node (in particular `collapsed` is untouched, so clearing
 * the filter restores the exact prior view). See docs/adr/0015.
 *
 * - `matchIds`: nodes whose own text carries all active tags.
 * - `visibleIds`: every match plus all of its ancestors up to (but not
 *   including) `rootId` -- the dimmed context that shows *where* a match lives.
 *
 * A node renders while filtered iff it is in `visibleIds`; it renders as a match
 * (normal styling) iff it is in `matchIds`, otherwise as dimmed context. Nodes
 * the view otherwise hides (e.g. completed subtrees when show-completed is off)
 * are skipped via the `isHidden` predicate -- this layer no longer knows about
 * `completed`; the composed Seam-G predicate carries that (ADR 0018 D9).
 */
export interface TagFilter {
  visibleIds: Set<string>
  matchIds: Set<string>
}

export function buildTagFilter(
  index: TreeIndex,
  rootId: string | null,
  activeTags: string[],
  isHidden: (node: Node) => boolean,
): TagFilter {
  const visibleIds = new Set<string>()
  const matchIds = new Set<string>()

  const walk = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
      // A hidden node takes its whole subtree with it, same as the normal
      // render (useVisibleChildIds applies the same composed predicate).
      if (isHidden(child)) continue
      if (matchesAllTags(child.text, activeTags)) {
        matchIds.add(child.id)
        let cur: Node | undefined = child
        while (cur && cur.id !== rootId) {
          visibleIds.add(cur.id)
          cur = cur.parentId ? index.byId.get(cur.parentId) : undefined
        }
      }
      walk(child.id)
    }
  }
  walk(rootId)

  return { visibleIds, matchIds }
}

/** Typed `q` search param, shared by the home and zoom routes. */
export interface OutlineSearch {
  q?: string
}

export function validateOutlineSearch(
  search: Record<string, unknown>,
): OutlineSearch {
  const q = typeof search.q === 'string' ? search.q.trim() : ''
  return q ? { q } : {}
}
