import { linkAtOffset, linkUrlAtOffset } from "../data/links";
import { getViewRootId } from "../data/view-state";
import { openLinkEditPopover } from "../plugins/links/link-edit-popover";
import { bibleRefUrlAtOffset } from "../plugins/route-bible/bible";
import type { PluginContext } from "../plugins/types";
import { getCaretOffset, readSource, setCaretOffset } from "./inline-code";
import { openUrlInFocusedTab } from "./open-url";

interface OpenInlineTargetOptions {
  linkParens?: "open" | "edit";
}

export function openInlineTargetAtCaret(
  el: HTMLElement,
  ctx?: PluginContext,
  options: OpenInlineTargetOptions = {},
): boolean {
  // getCaretOffset falls back to 0 when the selection lives outside `el`, and
  // offset 0 touches a line-leading token -- a Mod+click routed here before the
  // browser placed the caret would open the wrong link. No caret, no target.
  const sel = window.getSelection();
  if (!sel?.rangeCount || !el.contains(sel.getRangeAt(0).endContainer)) {
    return false;
  }
  const text = readSource(el);
  const caret = getCaretOffset(el);
  if (options.linkParens === "edit" && ctx && openLinkEditAtCaret(el, text, caret, ctx)) {
    return true;
  }
  const url = linkUrlAtOffset(text, caret) ?? bibleRefUrlAtOffset(text, caret);
  if (!url) return false;
  openUrlInFocusedTab(url, {
    restoreFocus: () => {
      el.focus({ preventScroll: true });
      setCaretOffset(el, caret);
    },
  });
  return true;
}

function openLinkEditAtCaret(
  el: HTMLElement,
  text: string,
  caret: number,
  ctx: PluginContext,
): boolean {
  const link = linkAtOffset(text, caret);
  if (!link) return false;

  const parensStart = link.start + 1 + link.label.length + 2; // after `(`
  if (caret < parensStart || caret >= link.end) return false;

  const nodeId =
    el.closest<HTMLElement>("[data-node-id]")?.getAttribute("data-node-id") ??
    getViewRootId();
  if (!nodeId) return false;

  const rect = caretRect(el);
  openLinkEditPopover(
    {
      nodeId,
      token: text.slice(link.start, link.end),
      label: link.label,
      url: link.url,
      x: rect.left,
      y: rect.bottom + 6,
      restoreFocus: () => {
        el.focus({ preventScroll: true });
        setCaretOffset(el, caret);
      },
    },
    ctx,
  );
  return true;
}

function caretRect(el: HTMLElement): DOMRect {
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) return rect;
  }
  return el.getBoundingClientRect();
}
