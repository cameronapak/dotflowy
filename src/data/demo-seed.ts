/**
 * The curated outline the landing hero demo loads (Approach B).
 *
 * This is MARKETING CONTENT, not the app's first-run welcome bullets
 * (src/data/seed.ts). It is designed to show the differentiators in one glance:
 *  - nesting (a real tree, not a flat list)
 *  - a colored `#tag` (Seam E tag color, synced through the same kv path)
 *  - a `[ ]` to-do, one done (the todos plugin's checkbox + strike-through)
 *  - a `[label](url)` rich link (folds to a clean anchor)
 *  - ONE node wearing the provenance sparkle (`origin` set) — the whole AI
 *    story on this brand: an assistant helped, you stayed the author.
 *
 * Delivered to the real collection via the demo backend's WS `snapshot` frame
 * (demo-backend.ts), exactly as the DO would on connect — so the editor loads
 * this tree with zero special-casing.
 */

// The seed rows are the shared, schema-derived `Node` type (wire-schema.ts) —
// NOT a hand-rolled copy — so adding a required Node field surfaces here as a
// compile error rather than silently emitting a snapshot the client's inbound
// decode (ServerMessageSchema) rejects, which would blank the whole demo
// (ADR 0013/0014; memory: the new-required-field gotcha). wire-schema imports
// only effect/Schema, so it's safe to import client-side.
import type { Node } from './wire-schema'

/** Structural fields the seed cares about; the rest default to inert. */
interface Seed {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask?: boolean
  completed?: boolean
  origin?: string | null
  /** Minutes ago the node was "created" (for the provenance hover time). */
  agoMin?: number
}

function toNode(s: Seed, base: number): Node {
  const created = base - (s.agoMin ?? 0) * 60_000
  return {
    id: s.id,
    parentId: s.parentId,
    prevSiblingId: s.prevSiblingId,
    text: s.text,
    isTask: s.isTask ?? false,
    completed: s.completed ?? false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: created,
    updatedAt: created,
    origin: s.origin ?? null,
  }
}

// A real-feeling personal outline. Three top-level threads: this week's work,
// ideas, and a set of notes an assistant drafted (the one AI touch). The "try
// it" invitation lives in the landing caption, not here — the outline stays
// authentic (show, don't tell).
const SEED: Seed[] = [
  // Thread 1 — this week, tagged + colored, with two to-dos and a rich link.
  { id: 'd-week', parentId: null, prevSiblingId: null, text: 'This week #focus' },
  {
    id: 'd-week-1',
    parentId: 'd-week',
    prevSiblingId: null,
    text: 'Finish the Dotflowy landing page',
    isTask: true,
  },
  {
    id: 'd-week-2',
    parentId: 'd-week',
    prevSiblingId: 'd-week-1',
    text: 'Move my notes over from the old app',
    isTask: true,
    completed: true,
  },
  {
    id: 'd-week-3',
    parentId: 'd-week',
    prevSiblingId: 'd-week-2',
    text: 'Reread [Deep Work](https://calnewport.com/books/deep-work/) #reading',
  },

  // Thread 2 — ideas, showing depth is free.
  { id: 'd-ideas', parentId: null, prevSiblingId: 'd-week', text: 'Ideas worth keeping' },
  {
    id: 'd-ideas-1',
    parentId: 'd-ideas',
    prevSiblingId: null,
    text: 'A quiet tool that stays out of your way',
  },
  {
    id: 'd-ideas-2',
    parentId: 'd-ideas',
    prevSiblingId: 'd-ideas-1',
    text: 'Notes nest as deep as you need — press Tab to try',
  },

  // Thread 3 — the one AI touch: an assistant drafted these; you own them.
  {
    id: 'd-call',
    parentId: null,
    prevSiblingId: 'd-ideas',
    text: "Notes from Tuesday's planning call",
    origin: 'Claude',
    agoMin: 42,
  },
  {
    id: 'd-call-1',
    parentId: 'd-call',
    prevSiblingId: null,
    text: 'Drafted by an assistant — you stay the author.',
    origin: 'Claude',
    agoMin: 42,
  },
]

/** The seed outline, timestamped at call time (client-side). */
export function demoSeedNodes(): Node[] {
  const base = Date.now()
  return SEED.map((s) => toNode(s, base))
}

/**
 * Pre-seeded plugin side-collections, keyed by kv namespace. `#focus` gets the
 * blue chip — leaning into the brand's one accent — so the colored-tag story
 * shows without the visitor having to right-click a tag. The value shape mirrors
 * `TagColorRow` (src/data/tag-colors.ts): `{ tag, color }`, keyed by the
 * normalized (lowercased, no `#`) tag name.
 */
export function demoSeedKv(): Record<string, { key: string; value: unknown }[]> {
  return {
    'tag-colors': [{ key: 'focus', value: { tag: 'focus', color: 'blue' } }],
  }
}
