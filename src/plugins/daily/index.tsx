// Daily Notes plugin (ADR 0019). Each calendar day gets a node; a header button
// jumps to today, creating it on first use. Built entirely on public seams plus
// two new ones this feature introduced:
//
//   - Seam F (header): the "Today" button (ADR 0020) -- node-less chrome.
//   - Protected nodes: the "Daily" container can't be deleted (ADR 0021).
//   - Seam F (row): the date badge on each day note.
//
// Identity lives in a side-collection (`daily-index.ts`), never on the `Node`
// schema or in text. Node creation is composed from the existing low-level
// `mutations.ts` primitives -- the same ones `appendChild` documents itself for
// ("seed code owns the wiring") -- NOT routed through `NodeCommands`, whose
// capture/pending-focus semantics are editor-edit concerns a get-or-create that
// navigates away doesn't want.

import { CalendarDaysIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { definePlugin, type PluginContext } from '../types'
import { appendChild, insertChildAtStart, setText } from '../../data/mutations'
import { childrenOf } from '../../data/tree'
import {
  CONTAINER_KEY,
  formatDayBadge,
  formatDayText,
  getContainerId,
  getDayId,
  isContainerNode,
  localDateKey,
  setMapping,
  useDailyDate,
} from './daily-index'

// --- get-or-create ----------------------------------------------------------

/**
 * The single "Daily" container, created lazily at the end of the top level.
 * Self-healing: a mapping that points at a node which no longer exists is
 * rebuilt (the container is protected, so this is belt-and-suspenders).
 */
function ensureContainer(ctx: PluginContext): string {
  const existing = getContainerId()
  if (existing && ctx.tree.byId.has(existing)) return existing
  const tops = childrenOf(ctx.tree, null)
  const after = tops.length ? tops[tops.length - 1]!.id : null
  const id = appendChild(null, after, 'Daily')
  setMapping(CONTAINER_KEY, id)
  return id
}

/**
 * The note for `key`, created as the FIRST child of the container (newest day
 * on top) if missing. Text seeds to the full date; the badge shows the relative
 * label. v1 caveat: creating an out-of-order past day (via a future picker)
 * still lands on top -- acceptable until the picker ships its own ordering.
 */
function ensureDay(key: string, containerId: string, ctx: PluginContext): string {
  const existing = getDayId(key)
  if (existing && ctx.tree.byId.has(existing)) return existing
  const id = insertChildAtStart(ctx.tree, containerId)
  setText(id, formatDayText(key))
  setMapping(key, id)
  return id
}

/** Ensure the container + the day exist, then zoom to the day. Date-generic so
 *  a future week picker is a pure caller (ADR 0019). */
function goToDate(key: string, ctx: PluginContext): void {
  const containerId = ensureContainer(ctx)
  const dayId = ensureDay(key, containerId, ctx)
  ctx.nav.zoom(dayId)
}

// --- header slot: the "Today" button ----------------------------------------

function TodayButton({ getCtx }: { getCtx: () => PluginContext }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => goToDate(localDateKey(), getCtx())}
    >
      <CalendarDaysIcon />
      <span className="sr-only">Today's daily note</span>
    </Button>
  )
}

// --- row slot: the date badge -----------------------------------------------

function DailyBadge({ nodeId }: { nodeId: string }) {
  const key = useDailyDate(nodeId)
  if (!key) return null
  return (
    <Badge variant="secondary" className="shrink-0" data-daily-date={key}>
      {formatDayBadge(key)}
    </Badge>
  )
}

export default definePlugin({
  id: 'daily',

  // Seam F (header): jump to today, creating it on first use. Reads ctx lazily.
  headerSlots: [
    {
      id: 'daily-today',
      render: (getCtx) => <TodayButton getCtx={getCtx} />,
    },
  ],

  // Seam F (row): the relative date pill, between the bullet dot and the text.
  // Renders only on a day note (useDailyDate returns null otherwise).
  slots: [
    {
      id: 'daily-date-badge',
      position: 'row:before-text',
      render: (node) => <DailyBadge nodeId={node.id} />,
    },
  ],

  // Protected nodes: the container can't be deleted -- it guards every day note
  // and everything written under them (removeNode cascades the subtree).
  protects: (nodeId) => isContainerNode(nodeId),
})
