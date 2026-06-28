import { useCallback, useSyncExternalStore } from 'react'
import { createCollection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { z } from 'zod'
import { normalizeTag } from './tags'
import { queryClient } from './query-client'
import { kvDelete, kvFetch, kvPut, toKvKeys, toKvRows } from './kv-api'

/**
 * Custom tag colors. A tag's color is **chosen**, not derived -- by default a
 * tag is a neutral outlined chip (`border-border`), and picking a color fills
 * it. The choice is keyed by the *normalized* tag name, so it applies to every
 * instance of that tag everywhere. See docs/adr/0007-custom-tag-colors.md.
 *
 * Backed by D1 through the generic /api/kv side-collection store (ADR 0008),
 * sibling to nodesCollection -- a custom color is shared meaning, not
 * view-state, so it syncs across devices. Empty by default; absence of a row
 * means "no color" (the neutral default).
 *
 * Color is applied through a single generated stylesheet keyed by `data-tag`
 * (see {@link tagColorsCss} and TagColorStyles), NOT a per-instance class -- so
 * recoloring a tag updates one rule and every chip/pill/menu-row repaints with
 * zero React re-renders.
 */
export const TAG_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const

/** Light/dark `--tag-*` pairs consumed by {@link tagColorsCss} overrides. */
export const tagColorPaletteCss = `
:root {
  --tag-red: oklch(0.94 0.045 25);
  --tag-red-fg: oklch(0.48 0.16 25);
  --tag-orange: oklch(0.94 0.05 55);
  --tag-orange-fg: oklch(0.48 0.13 50);
  --tag-amber: oklch(0.95 0.06 90);
  --tag-amber-fg: oklch(0.47 0.11 85);
  --tag-green: oklch(0.94 0.06 150);
  --tag-green-fg: oklch(0.45 0.13 150);
  --tag-teal: oklch(0.94 0.05 195);
  --tag-teal-fg: oklch(0.46 0.1 200);
  --tag-blue: oklch(0.94 0.05 250);
  --tag-blue-fg: oklch(0.49 0.15 255);
  --tag-indigo: oklch(0.94 0.05 280);
  --tag-indigo-fg: oklch(0.49 0.16 280);
  --tag-purple: oklch(0.94 0.05 310);
  --tag-purple-fg: oklch(0.49 0.17 310);
  --tag-pink: oklch(0.94 0.05 345);
  --tag-pink-fg: oklch(0.49 0.17 345);
}
.dark {
  --tag-red: oklch(0.34 0.055 25);
  --tag-red-fg: oklch(0.85 0.1 25);
  --tag-orange: oklch(0.34 0.055 55);
  --tag-orange-fg: oklch(0.86 0.1 60);
  --tag-amber: oklch(0.35 0.06 90);
  --tag-amber-fg: oklch(0.88 0.11 90);
  --tag-green: oklch(0.34 0.06 150);
  --tag-green-fg: oklch(0.86 0.11 150);
  --tag-teal: oklch(0.34 0.055 195);
  --tag-teal-fg: oklch(0.85 0.09 200);
  --tag-blue: oklch(0.34 0.06 250);
  --tag-blue-fg: oklch(0.84 0.11 255);
  --tag-indigo: oklch(0.34 0.06 280);
  --tag-indigo-fg: oklch(0.84 0.12 280);
  --tag-purple: oklch(0.34 0.06 310);
  --tag-purple-fg: oklch(0.85 0.12 310);
  --tag-pink: oklch(0.34 0.06 345);
  --tag-pink-fg: oklch(0.85 0.12 345);
}
`.trim()

export type TagColor = (typeof TAG_COLORS)[number]

const TAG_COLOR_SET = new Set<string>(TAG_COLORS)

const tagColorSchema = z.object({
  /** Normalized tag name (no `#`, lowercased) -- the row key. */
  tag: z.string(),
  /** One of {@link TAG_COLORS}. */
  color: z.string(),
})

export type TagColorRow = z.infer<typeof tagColorSchema>

const KV = 'tag-colors'

export const tagColorsCollection = createCollection(
  queryCollectionOptions({
    id: 'tag-colors',
    queryKey: ['kv', KV],
    queryClient,
    queryFn: () => kvFetch<TagColorRow>(KV),
    getKey: (row: TagColorRow) => row.tag,
    schema: tagColorSchema,
    // Insert and update both upsert the whole row (tiny key->value items).
    onInsert: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction))
      return { refetch: false }
    },
    onUpdate: async ({ transaction }) => {
      await kvPut(KV, toKvRows(transaction))
      return { refetch: false }
    },
    onDelete: async ({ transaction }) => {
      await kvDelete(KV, toKvKeys(transaction))
      return { refetch: false }
    },
  }),
)

/** Set (or change) a tag's color -- applies to every instance of the tag. */
export function setTagColor(tag: string, color: TagColor) {
  const key = normalizeTag(tag)
  if (!key) return
  const exists = tagColorsCollection.toArray.some((r) => r.tag === key)
  if (exists) tagColorsCollection.update(key, (draft) => void (draft.color = color))
  else tagColorsCollection.insert({ tag: key, color })
}

/** Clear a tag's color -- back to the neutral outlined default ("Auto"). */
export function clearTagColor(tag: string) {
  const key = normalizeTag(tag)
  if (tagColorsCollection.toArray.some((r) => r.tag === key)) {
    tagColorsCollection.delete(key)
  }
}

/**
 * The override stylesheet body: one rule per colored tag, keyed by `data-tag`
 * (case-insensitively, so any casing of the tag matches the lowercased key).
 * The doubled `[data-tag]` bumps specificity above the single-class default so
 * the fill wins. Invalid colors / unsafe tag names are skipped.
 */
export function tagColorsCss(rows: TagColorRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (TAG_COLOR_SET.has(r.color) && /^[\p{L}\p{N}_-]+$/u.test(r.tag)) {
      lines.push(`[data-tag="${r.tag}" i][data-tag]{background:var(--tag-${r.color});color:var(--tag-${r.color}-fg);border-color:transparent}`);
      lines.push(
        `[data-tag="${r.tag}" i][data-tag-pill][data-tag] [data-tag-pill-remove]:hover{background:color-mix(in oklch,var(--tag-${r.color}-fg) 14%,transparent);color:var(--tag-${r.color}-fg)}`,
      );
    }
  }
  return lines.join('\n');
}

// --- Reactive read (mirrors tree-store: subscribeChanges + useSyncExternalStore,
// not useLiveQuery, which hard-fails the `/` prerender -- ADR 0004). ---

const EMPTY: TagColorRow[] = []
let rows: TagColorRow[] = EMPTY
const listeners = new Set<() => void>()
let started = false

function rebuild() {
  rows = tagColorsCollection.toArray
  for (const l of listeners) l()
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  tagColorsCollection.subscribeChanges(() => rebuild(), {
    includeInitialState: true,
  })
}

function subscribe(cb: () => void): () => void {
  ensureStarted()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getRows(): TagColorRow[] {
  ensureStarted()
  return rows
}

/** All color rows, reactive. Drives the generated stylesheet. */
export function useTagColorRows(): TagColorRow[] {
  return useSyncExternalStore(subscribe, getRows, () => EMPTY)
}

/** The current color of one tag, reactive (for the picker's selected swatch). */
export function useTagColor(tag: string): TagColor | null {
  const key = normalizeTag(tag)
  const getSnapshot = useCallback(() => {
    const row = getRows().find((r) => r.tag === key)
    return row && TAG_COLOR_SET.has(row.color) ? (row.color as TagColor) : null
  }, [key])
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
