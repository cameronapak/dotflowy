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

import { CalendarArrowDownIcon, CalendarDaysIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { definePlugin, type PluginContext } from '../types'
import { capture } from '../../data/history'
import {
  appendChild,
  insertChildAtStart,
  moveNode,
  setText,
} from '../../data/mutations'
import { childrenOf, type TreeIndex } from '../../data/tree'
import {
  CONTAINER_KEY,
  formatDayBadge,
  formatDayText,
  getContainerId,
  getDayId,
  getDayKey,
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
function ensureContainer(index: TreeIndex): string {
  const existing = getContainerId()
  if (existing && index.byId.has(existing)) return existing
  const tops = childrenOf(index, null)
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
function ensureDay(key: string, containerId: string, index: TreeIndex): string {
  const existing = getDayId(key)
  if (existing && index.byId.has(existing)) return existing
  const id = insertChildAtStart(index, containerId)
  setText(id, formatDayText(key))
  setMapping(key, id)
  return id
}

/** Ensure the container + the day exist and return the day's node id (no nav).
 *  Takes just the tree index (not a `PluginContext`) so the Today button, the
 *  `/` command, AND the Cmd+K virtual action (Seam J -- which has no
 *  `PluginContext`) all reuse the exact same get-or-create (ADR 0019/0022). */
function getOrCreateDay(key: string, index: TreeIndex): string {
  return ensureDay(key, ensureContainer(index), index)
}

/** get-or-create the day, then zoom to it (the Today button + future picker). */
function goToDate(key: string, ctx: PluginContext): void {
  ctx.nav.zoom(getOrCreateDay(key, ctx.tree))
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
    <Badge variant="secondary" className="shrink-0 mt-1" data-daily-date={key}>
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

  // Seam C: a `/` command to move the focused node under today's note. Mirrors
  // the core `/move` completion (move-dialog.tsx): one undo step, append as
  // today's last child, then stay put + toast with a "Go" to jump there. Label
  // deliberately avoids "move" -- the menu substring-matches label+keywords, so
  // "Move to Today" would shadow the core `/move`. "/today" finds this; "/move"
  // stays the general mover.
  commands: [
    {
      id: 'send-to-today',
      label: 'Send to Today',
      description: "Move this node under today's daily note",
      icon: CalendarArrowDownIcon,
      keywords: ['today', 'daily', 'journal'],
      available: () => true,
      run: (nodeId, ctx) => {
        const todayId = getOrCreateDay(localDateKey(), ctx.tree)
        if (todayId === nodeId) return // can't move today's note under itself
        capture(ctx.tree, nodeId)
        const kids = childrenOf(ctx.tree, todayId)
        const after = kids.length ? kids[kids.length - 1]!.id : null
        if (moveNode(ctx.tree, nodeId, todayId, after)) {
          toast.success('Moved to Today', {
            action: { label: 'Go', onClick: () => ctx.nav.zoom(todayId) },
          })
        }
      },
    },
  ],

  // Protected nodes: the container can't be deleted -- it guards every day note
  // and everything written under them (removeNode cascades the subtree).
  protects: (nodeId) => isContainerNode(nodeId),

  // Seam J: make day notes findable by their RELATIVE label in the Cmd+K
  // switcher and the /move picker, even though the node's text is the full date.
  // Matched (a second Fuse key) but never highlighted -- the row still shows the
  // date text. "Today"/"Yesterday"/"Tomorrow"/"Jun 23" from the id->date mapping.
  searchAliases: (node) => {
    const key = getDayKey(node.id)
    return key ? [formatDayBadge(key)] : []
  },

  // Seam J: a VIRTUAL switcher row that appears only when today's note does NOT
  // exist yet (when it does, the alias above surfaces the real node -- no dup).
  // Picking it creates the note + container, then navigates. This is the "search
  // today even if it isn't there" half (ADR 0022).
  searchActions: (query, ctx) => {
    const q = query.trim().toLowerCase()
    if (q.length < 2 || !'today'.startsWith(q)) return []
    const key = localDateKey()
    const existing = getDayId(key)
    if (existing && ctx.index.byId.has(existing)) return []
    return [
      {
        key: 'daily-go-today',
        label: 'Go to Today',
        hint: "Creates today's daily note",
        icon: CalendarDaysIcon,
        run: () => ctx.goTo(getOrCreateDay(key, ctx.index)),
      },
    ]
  },
})
