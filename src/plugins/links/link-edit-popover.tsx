// The Edit Link popover (ADR 0005, bracket reveal). The URL half of a link
// never expands into the line -- editing it happens HERE, opened from the
// pencil affordance on a folded <a> or the `(✎)` chip of a revealed link.
// Two fields (text + url), Done/Cancel, no preview embed (rejected by design).
//
// Write-back is verbatim-match-or-drop (replaceLinkToken): the popover captures
// the token at open time; if the line was edited underneath it (another device,
// a late unfurl), Done drops the edit instead of corrupting the line -- the
// same contract as the unfurl label swap (ADR 0016).

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "../../components/use-dismissable";
import { Button, Input } from "@/plugins/kit";
import {
  encodeUrlForMarkdown,
  replaceLinkToken,
  sanitizeLinkLabel,
} from "../../data/links";
import { getTreeIndex } from "../../data/tree-store";
import type { NodeCommands } from "../../components/OutlineNode";
import type { PluginContext } from "../types";

/** Build the edited token and splice it over the old one in the node's LIVE
 *  text (read at submit time, not open time -- the user may have typed since).
 *  A mirror row edits its SOURCE node (`mirrorOf`), matching where the text
 *  lives. Exported for the plugin's interaction handler; pure except the one
 *  tree read + the onTextChange write. */
export function submitLinkEdit(
  nodeId: string,
  oldToken: string,
  label: string,
  url: string,
  mutations: NodeCommands,
): void {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return;
  const safeLabel = sanitizeLinkLabel(label) || trimmedUrl;
  const newToken = `[${safeLabel}](${encodeUrlForMarkdown(trimmedUrl)})`;
  if (newToken === oldToken) return;
  const index = getTreeIndex();
  const clicked = index.byId.get(nodeId);
  if (!clicked) return;
  const targetId = clicked.mirrorOf ?? nodeId;
  const current = index.byId.get(targetId)?.text;
  if (current == null) return;
  const next = replaceLinkToken(current, oldToken, newToken);
  if (next != null && next !== current) mutations.onTextChange(targetId, next);
}

/** Mount the popover through the overlay host (the same thin `ctx.openOverlay`
 *  the tag color picker uses). Lives here so the plugin's index stays JSX-free. */
export function openLinkEditPopover(
  args: {
    nodeId: string;
    token: string;
    label: string;
    url: string;
    x: number;
    y: number;
    restoreFocus?: () => void;
  },
  ctx: PluginContext,
): void {
  const close = () => {
    ctx.openOverlay(null);
    requestAnimationFrame(() => args.restoreFocus?.());
  };
  ctx.openOverlay(
    <LinkEditPopover
      label={args.label}
      url={args.url}
      x={args.x}
      y={args.y}
      onSubmit={(label, url) =>
        submitLinkEdit(args.nodeId, args.token, label, url, ctx.mutations)
      }
      onClose={close}
    />,
  );
}

/** CREATE a link over a selection (ADR 0036): build `[label](url)` and splice it
 *  into the node's LIVE text at the captured range. Verbatim-safe like
 *  submitLinkEdit -- if the line is unchanged since the popover opened we splice
 *  by offset, otherwise we fall back to the first occurrence of the selected
 *  text; if neither matches (the line was edited out from under us) the create
 *  is dropped rather than corrupting the line. No url = no link (Cancel-like). */
export function submitLinkCreate(
  args: {
    nodeId: string;
    source: string;
    start: number;
    end: number;
    selText: string;
  },
  label: string,
  url: string,
  mutations: NodeCommands,
): void {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return;
  const safeLabel = sanitizeLinkLabel(label) || trimmedUrl;
  const token = `[${safeLabel}](${encodeUrlForMarkdown(trimmedUrl)})`;
  const current = getTreeIndex().byId.get(args.nodeId)?.text;
  if (current == null) return;

  let next: string | null = null;
  if (current === args.source) {
    next = current.slice(0, args.start) + token + current.slice(args.end);
  } else if (args.selText) {
    const at = current.indexOf(args.selText);
    if (at >= 0)
      next =
        current.slice(0, at) + token + current.slice(at + args.selText.length);
  }
  if (next != null && next !== current) mutations.onTextChange(args.nodeId, next);
}

/** Open the create-link popover prefilled with the selected text as the label
 *  and an empty url, positioned at the selection. Reuses LinkEditPopover so
 *  create + edit share one UI. */
export function openLinkCreatePopover(
  args: {
    nodeId: string;
    source: string;
    start: number;
    end: number;
    selText: string;
    x: number;
    y: number;
  },
  ctx: PluginContext,
): void {
  ctx.openOverlay(
    <LinkEditPopover
      label={args.selText}
      url=""
      x={args.x}
      y={args.y}
      onSubmit={(label, url) =>
        submitLinkCreate(args, label, url, ctx.mutations)
      }
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}

/**
 * The popover itself: anchored below the clicked link (fixed, clamped on
 * screen), dismissed on outside pointerdown or Escape, submitted on Done or
 * Enter. Opened through ctx.openOverlay (the same thin host as the tag color
 * picker), so it owns its own positioning + dismiss.
 */
export function LinkEditPopover({
  label: initialLabel,
  url: initialUrl,
  x,
  y,
  onSubmit,
  onClose,
}: {
  label: string;
  url: string;
  x: number;
  y: number;
  onSubmit: (label: string, url: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const [label, setLabel] = useState(initialLabel);
  const [url, setUrl] = useState(initialUrl);

  useDismissable(ref, onClose);

  // Keep the popover on screen (~320px wide, ~150px tall).
  const left = Math.max(8, Math.min(x, window.innerWidth - 336));
  const top = Math.max(8, Math.min(y, window.innerHeight - 160));

  return createPortal(
    <form
      ref={ref}
      role="dialog"
      aria-label="Edit link"
      data-link-edit-popover
      className="bg-popover fixed z-50 flex w-80 flex-col gap-2 rounded-lg border p-3 shadow-md"
      style={{ left, top }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(label, url);
        onClose();
      }}
    >
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        aria-label="Link text"
        placeholder="Link text"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
      />
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Link URL"
        placeholder="https://…"
        type="text"
        inputMode="url"
        spellCheck={false}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Done
        </Button>
      </div>
    </form>,
    document.body,
  );
}
