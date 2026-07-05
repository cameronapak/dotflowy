// Node links (ADR 0032): the pure `[[nodeId]]` layer. A LINK is a pointer you
// travel through -- stored in the referring node's text as `[[<id>]]`, rendered
// as the target's live text, click zooms. Never a window into content (that's a
// MIRROR, ADR 0022). This module owns the token grammar + parsing + flattening;
// the experience lives in src/plugins/node-links/ (the src/data/tags.ts split:
// core-known format, plugin-owned UX -- core chrome like the backlinks line may
// depend on this file, never on the plugin).

import { flattenInline } from './inline-text'
import type { TreeIndex } from './tree'

// The token matches ONLY id-shaped interiors (a UUID from crypto.randomUUID, or
// tree.ts's `n_<t36>_<r36>` fallback). Deliberately strict: hand-typed junk like
// `[[not an id]]` stays literal text (link creation goes through the `[[`
// picker), while a real token whose target was DELETED still matches and renders
// as a "missing link" chip -- the strictness is what tells those two apart.
const UUID_SRC =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const FALLBACK_ID_SRC = 'n_[0-9a-z]+_[0-9a-z]+'
const ID_SRC = `(?:${UUID_SRC}|${FALLBACK_ID_SRC})`

/** Seam A regex fragment (no outer capture group -- the registry wraps it). */
export const NODE_LINK_PATTERN = `\\[\\[${ID_SRC}\\]\\]`

// Internal, with the id captured. Fresh-flagged `g` for matchAll/replace.
const NODE_LINK_REGEX = new RegExp(`\\[\\[(${ID_SRC})\\]\\]`, 'g')

/** The target id inside one matched token: `[[abc]]` -> `abc`. */
export function linkTargetId(tok: string): string {
  return tok.slice(2, -2)
}

const EMPTY: string[] = []

/**
 * The unique target ids `text` links to, in first-occurrence order. Runs on the
 * tree-store's per-change path, so it bails before any regex work when the text
 * can't contain a token (the 99.9% case).
 */
export function parseNodeLinks(text: string): string[] {
  if (!text.includes('[[')) return EMPTY
  let out: string[] | null = null
  for (const m of text.matchAll(NODE_LINK_REGEX)) {
    const id = m[1]!
    if (!out) out = [id]
    else if (!out.includes(id)) out.push(id)
  }
  return out ?? EMPTY
}

/**
 * A linked-to node's display label: its text with markup flattened AND any
 * node-link tokens of its own reduced to an ellipsis -- resolution is ONE level
 * deep by construction, so a link chain (or cycle) can never recurse.
 */
export function linkedNodeLabel(text: string): string {
  return flattenInline(
    text.includes('[[') ? text.replace(NODE_LINK_REGEX, '…') : text,
  )
}

/**
 * Flatten `text` to its plain reading form INCLUDING node links -- each
 * `[[id]]` becomes the target's label (or "missing link" when the target is
 * gone), then the usual {@link flattenInline}. The index-aware step of the
 * flatten chain (ADR 0032): search corpora, picker titles, and breadcrumbs use
 * this so a linked node reads as its text, never as a raw `[[uuid]]`.
 */
export function flattenNodeText(index: TreeIndex, text: string): string {
  if (!text.includes('[[')) return flattenInline(text)
  const resolved = text.replace(NODE_LINK_REGEX, (_tok, id: string) => {
    const target = index.byId.get(id)
    return target ? linkedNodeLabel(target.text) : 'missing link'
  })
  return flattenInline(resolved)
}
