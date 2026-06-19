import { useCallback, useEffect, useRef } from 'react'
import { useTree } from '../data/useTree'
import { childrenOf, type TreeIndex } from '../data/tree'
import {
  indent,
  insertSibling,
  outdent,
  removeNode,
  setText,
  toggleCollapsed,
  toggleCompleted,
} from '../data/mutations'
import { seedIfEmpty } from '../data/seed'
import { OutlineNode, type NodeCommands } from './OutlineNode'

/**
 * Top-level outline editor. Owns:
 *  - reading the live tree
 *  - seeding on first run
 *  - focus management across bullets
 *  - translating keyboard commands into mutations
 */
export function OutlineEditor() {
  const { index } = useTree()

  // Refs registry: id -> contentEditable span. Lets us move focus
  // between bullets after structural mutations.
  const refs = useRef<Map<string, HTMLSpanElement | null>>(new Map())
  const registerRef = useCallback(
    (id: string, el: HTMLSpanElement | null) => {
      if (el) refs.current.set(id, el)
      else refs.current.delete(id)
    },
    [],
  )

  // First-run seed. Runs when the collection has loaded and is empty.
  const topLevel = childrenOf(index, null)
  useEffect(() => {
    // hasAnyNode is true if any node at all exists. We can't tell "loaded
    // but empty" from "not yet loaded" purely from useLiveQuery in v1;
    // localStorage is synchronous though, so reading the raw key is safe.
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem('workflowy-oss:nodes')
      : null
    if (raw === null) seedIfEmpty(false)
  }, [])

  // Track the most recently inserted/focused node id so we can focus it
  // after the next render. Storing in a ref + state-like cursor.
  const pendingFocus = useRef<string | null>(null)

  // After every render, if a focus is pending and the target exists, focus it.
  useEffect(() => {
    if (pendingFocus.current) {
      const el = refs.current.get(pendingFocus.current)
      if (el) {
        el.focus()
        // Place caret at end for natural typing flow.
        placeCaretAtEnd(el)
      }
      pendingFocus.current = null
    }
  })

  const focusIndex = useRef<TreeIndex>(index)
  focusIndex.current = index

  const commands: NodeCommands = {
    onTextChange: (id, text) => setText(id, text),

    onEnter: (id) => {
      const node = focusIndex.current.byId.get(id)
      if (!node) return
      const newId = insertSibling(focusIndex.current, node.parentId, id)
      pendingFocus.current = newId
    },

    onIndent: (id) => {
      indent(focusIndex.current, id)
    },

    onOutdent: (id) => {
      outdent(focusIndex.current, id)
    },

    onDeleteEmpty: (id) => {
      const focusId = removeNode(focusIndex.current, id)
      if (focusId) pendingFocus.current = focusId
    },

    onToggleCompleted: (id, completed) => toggleCompleted(id, completed),

    onToggleCollapsed: (id, collapsed) => toggleCollapsed(id, collapsed),

    onMoveFocus: (id, direction) => {
      const target = findVisibleNeighbor(focusIndex.current, id, direction)
      if (target) {
        const el = refs.current.get(target)
        if (el) {
          el.focus()
          placeCaretAtStart(el)
        }
      }
    },
  }

  return (
    <div className="outline-root">
      <ul className="outline-list">
        {topLevel.map((node) => (
          <OutlineNode
            key={node.id}
            node={node}
            index={index}
            commands={commands}
            registerRef={registerRef}
          />
        ))}
      </ul>
      {topLevel.length === 0 && (
        <div className="outline-empty">
          Empty. Click below to add your first bullet.
        </div>
      )}
      {/* Click anywhere in the whitespace below the list adds a new top-level bullet. */}
      <button
        type="button"
        className="add-top"
        onClick={() => {
          const siblings = childrenOf(focusIndex.current, null)
          const afterId = siblings.length ? siblings[siblings.length - 1]!.id : null
          const newId = insertSibling(focusIndex.current, null, afterId)
          pendingFocus.current = newId
        }}
      >
        + Add bullet
      </button>
    </div>
  )
}

/**
 * Walk the visible (non-collapsed) outline in display order and return
 * the id of the node immediately before/after `id`, or null if none.
 */
function findVisibleNeighbor(
  index: TreeIndex,
  id: string,
  direction: 'up' | 'down',
): string | null {
  const flat = flattenVisible(index)
  const i = flat.findIndex((n) => n.id === id)
  if (i === -1) return null
  const neighbor = direction === 'up' ? flat[i - 1] : flat[i + 1]
  return neighbor ? neighbor.id : null
}

function flattenVisible(index: TreeIndex): Array<{ id: string }> {
  const out: Array<{ id: string }> = []
  const walk = (parentId: string | null) => {
    for (const child of childrenOf(index, parentId)) {
      out.push({ id: child.id })
      if (!child.collapsed) walk(child.id)
    }
  }
  walk(null)
  return out
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function placeCaretAtStart(el: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}
