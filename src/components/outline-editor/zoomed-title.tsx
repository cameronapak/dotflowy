import { useEffect, useRef } from "react";
import {
  useHotkeys,
  type UseHotkeyDefinition,
} from "@tanstack/react-hotkeys";
import type { Node } from "../../data/schema";
import { hasLink } from "../../plugins/links/links";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  watchCaretReveal,
} from "../inline-code";
import { pasteIntoBullet } from "../paste";
import { keymapSpecs, composeSelfCompleted } from "../../plugins/registry";
import type { PluginContext } from "../../plugins/types";

/**
 * The zoomed node rendered as an editable page title. Mirrors OutlineNode's
 * contentEditable text-sync so the caret is never clobbered during typing.
 */
export function ZoomedTitle({
  node,
  isPivot,
  registerRef,
  getCtx,
  onTextChange,
  onAddChild,
  onArrowDown,
}: {
  node: Node;
  isPivot: boolean;
  registerRef: (id: string, el: HTMLSpanElement | null) => void;
  /** The PluginContext factory, so the plugin keymap (Seam D) works on the
   *  title too -- Mod+Enter / Mod+D toggle completion of the zoomed node. */
  getCtx: () => PluginContext;
  onTextChange: (text: string) => void;
  onAddChild: () => void;
  onArrowDown: () => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Mirror OutlineNode's live inline-`code` decoration so a backtick run in the
  // title renders as a mono chip too. See inline-code.ts and OutlineNode.
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || composingRef.current) return;
    if (syncedRef.current === node.text) return;
    const focused = document.activeElement === el;
    const revealOffset = focused ? getCaretOffset(el) : null;
    decorate(el, node.text, revealOffset, focused);
    syncedRef.current = node.text;
  });

  // Title shortcuts, scoped to the title's own contentEditable. Enter adds a
  // first child under the title; ArrowDown drops focus into the first child.
  // The plugin keymap (Seam D) is registered here too, so todos' Mod+Enter /
  // Mod+D toggle completion of the zoomed node just like on a list-item bullet.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onAddChild() },
      { hotkey: "ArrowDown", callback: () => onArrowDown() },
      ...keymapSpecs.map((k) => ({
        hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
        callback: () => k.run(node.id, getCtx()),
      })),
    ],
    { target: ref },
  );

  return (
    <h2 className="zoomed-title">
      <span
        ref={(el) => {
          ref.current = el;
          registerRef(node.id, el);
        }}
        className={`node-text zoomed-title-text${isPivot ? " vt-morph" : ""}`}
        style={isPivot ? { viewTransitionName: "zoom-target" } : undefined}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        aria-label="Title"
        aria-multiline="true"
        data-completed={composeSelfCompleted(node)}
        onInput={(e) => {
          const el = e.currentTarget;
          const text = readSource(el);
          onTextChange(text);
          // Re-decorate live, revealing the link under the caret. Suspended
          // during IME composition; compositionend handles that case.
          if (!composingRef.current) {
            decorate(el, text, getCaretOffset(el), true);
            syncedRef.current = text;
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          const el = e.currentTarget;
          const text = readSource(el);
          onTextChange(text);
          decorate(el, text, getCaretOffset(el), true);
          syncedRef.current = text;
        }}
        onPaste={(e) => {
          const el = e.currentTarget;
          const next = pasteIntoBullet(e, el, onTextChange);
          if (next !== null) syncedRef.current = next;
        }}
        onFocus={(e) => {
          // Per-link reveal in the title (ADR 0017): watch the caret, and
          // reveal the link it's currently on. Link-free is a no-op so the
          // native caret stands.
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = watchCaretReveal(
            el,
            () => composingRef.current,
          );
          // Deferred to the next frame so a CLICK at the title's end settles on
          // the folded layout before the link expands; see revealLinkAtCaret.
          if (!hasLink(node.text)) return;
          revealLinkAtCaret(el, node.text, () => {
            syncedRef.current = node.text;
          });
        }}
        onBlur={(e) => {
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = null;
          const text = readSource(el);
          if (hasLink(text)) {
            decorate(el, text, null, false);
            syncedRef.current = text;
          }
        }}
      />
    </h2>
  );
}
