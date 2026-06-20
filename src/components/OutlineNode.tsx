import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Node } from '../data/schema'
import type { TreeIndex } from '../data/tree'
import { childrenOf } from '../data/tree'

interface OutlineNodeProps {
  node: Node
  index: TreeIndex
  // Commands the editor knows how to run. Keeping them as a single
  // object avoids each node importing mutations + focus logic directly.
  commands: NodeCommands
  // Refs registry so the editor can move focus between bullets.
  registerRef: (id: string, el: HTMLSpanElement | null) => void
  // The node currently morphing across a zoom navigation, if any. When this
  // node is the pivot, its text claims the shared view-transition-name.
  pivotId: string | null
}

export interface NodeCommands {
  onTextChange: (id: string, text: string) => void
  onEnter: (id: string, caretAtEnd: boolean) => void
  onIndent: (id: string) => void
  onOutdent: (id: string) => void
  onDeleteEmpty: (id: string) => void
  onToggleCompleted: (id: string, completed: boolean) => void
  onToggleCollapsed: (id: string, collapsed: boolean) => void
  onMoveFocus: (id: string, direction: 'up' | 'down') => void
  // Zoom the outline so this node becomes the temporary root.
  onZoom: (id: string) => void
}

export const OutlineNode = memo(function OutlineNode({
  node,
  index,
  commands,
  registerRef,
  pivotId,
}: OutlineNodeProps) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const children = childrenOf(index, node.id)
  const hasChildren = children.length > 0
  const isPivot = node.id === pivotId

  // Keep the contentEditable in sync with stored text WITHOUT clobbering
  // the user's caret. We only write to the DOM when the stored text
  // differs from what's rendered, which is essentially never during
  // typing (the keystroke updates the store which echoes back equal).
  useEffect(() => {
    const el = textRef.current
    if (el && el.textContent !== node.text) {
      el.textContent = node.text
    }
  })

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    // Enter: create a new sibling. Caret position is irrelevant for the
    // mutation, but we pass it so the editor can decide mid-text split
    // later. For v1 we always make an empty sibling after this node.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commands.onEnter(node.id, isCaretAtEnd(e.currentTarget))
      return
    }

    // Tab / Shift+Tab: indent / outdent.
    if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) commands.onOutdent(node.id)
      else commands.onIndent(node.id)
      return
    }

    // Backspace on empty: delete and focus the previous node.
    // contentEditable spans have no selectionStart; check emptiness via
    // textContent and a collapsed caret at offset 0.
    if (
      e.key === 'Backspace' &&
      e.currentTarget.textContent === '' &&
      isCaretAtStart(e.currentTarget)
    ) {
      e.preventDefault()
      commands.onDeleteEmpty(node.id)
      return
    }

    // Arrow up/down at line edges: move between siblings for that
    // outline feel. Simple version: jump to prev/next visible node.
    if (e.key === 'ArrowUp' && atLineStart(e.currentTarget)) {
      e.preventDefault()
      commands.onMoveFocus(node.id, 'up')
      return
    }
    if (e.key === 'ArrowDown' && atLineEnd(e.currentTarget)) {
      e.preventDefault()
      commands.onMoveFocus(node.id, 'down')
      return
    }
  }

  return (
    <li className="outline-node" data-node-id={node.id}>
      <div className="outline-row">
        <button
          type="button"
          className="collapse-toggle"
          aria-label={node.collapsed ? 'Expand' : 'Collapse'}
          data-has-children={hasChildren}
          data-collapsed={node.collapsed}
          // Childless rows render no glyph but keep the gutter clickable-free.
          onClick={() =>
            hasChildren && commands.onToggleCollapsed(node.id, !node.collapsed)
          }
          tabIndex={-1}
        >
          {hasChildren &&
            (node.collapsed ? (
              <ChevronRight size={14} strokeWidth={2.5} />
            ) : (
              <ChevronDown size={14} strokeWidth={2.5} />
            ))}
        </button>
        <button
          type="button"
          className="bullet"
          aria-label="Zoom in"
          onClick={() => commands.onZoom(node.id)}
          title="Zoom in"
        >
          <span
            className="bullet-dot"
            data-completed={node.completed}
            data-has-children={hasChildren}
          />
        </button>
        <input
          type="checkbox"
          className="checkbox"
          aria-label="Complete"
          checked={node.completed}
          onChange={(e) => commands.onToggleCompleted(node.id, e.target.checked)}
        />
        <span
          ref={(el) => {
            textRef.current = el
            registerRef(node.id, el)
          }}
          className={`node-text${isPivot ? ' vt-morph' : ''}`}
          style={isPivot ? { viewTransitionName: 'zoom-target' } : undefined}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          data-completed={node.completed}
          onInput={(e) => commands.onTextChange(node.id, e.currentTarget.textContent ?? '')}
          onKeyDown={handleKeyDown}
        />
      </div>

      {!node.collapsed && hasChildren && (
        <ul className="outline-children">
          {children.map((child) => (
            <OutlineNode
              key={child.id}
              node={child}
              index={index}
              commands={commands}
              registerRef={registerRef}
              pivotId={pivotId}
            />
          ))}
        </ul>
      )}
    </li>
  )
})

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return true
  const range = sel.getRangeAt(0)
  return range.endOffset === el.textContent?.length
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return true
  return sel.getRangeAt(0).endOffset === 0
}

function atLineStart(el: HTMLElement): boolean {
  return isCaretAtStart(el)
}

function atLineEnd(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  return sel.getRangeAt(0).endOffset === (el.textContent?.length ?? 0)
}
