// The Edit Link popover (ADR 0005, bracket reveal). The URL half of a link
// never expands into the line -- editing it happens HERE, opened from the
// pencil affordance on a folded <a> or the `(✎)` chip of a revealed link.
// URL, title, and display tiles share one draft, committed only on Done.
//
// Write-back captures the source and clicked range at open time. If the line
// changes underneath it (another device, a late unfurl), Done drops the edit
// rather than guessing which occurrence the user meant.

import {
  LinkSquare02Icon,
  TextIcon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  Button,
  Input,
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  ToggleGroup,
  ToggleGroupItem,
  MenuSheetContent,
} from "@/plugins/kit";

import type { NodeCommands } from "../../components/node-commands";
import type { PluginContext } from "../types";

import { useDismissable } from "../../components/use-dismissable";
import {
  getEditorFeatures,
  useEditorFeatures,
} from "../../data/editor-features";
import { embedResource } from "../../data/embed-providers";
import { encodeUrlForMarkdown, sanitizeLinkLabel } from "../../data/links";
import { getTreeIndex } from "../../data/tree-store";
import { useIsMobile } from "../../hooks/use-mobile";
import { requestPermission } from "../embeds/permission";
import { cancelNodeUnfurl, unfurlNodeLinks } from "./unfurl";

type DisplayAs = "link" | "plain" | "embed";

/** Build the edited token and splice it over the old one in the node's LIVE
 *  text (read at submit time, not open time -- the user may have typed since).
 *  A mirror row edits its SOURCE node (`mirrorOf`), matching where the text
 *  lives. Display conversions use the existing kind command and leave children
 *  untouched. Cancel pending metadata before applying the explicit edit. */
export function submitLinkEdit(
  nodeId: string,
  oldToken: string,
  label: string,
  url: string,
  mutations: NodeCommands,
  display: DisplayAs,
  range: { source: string; start: number; end: number },
): { before: string; text: string; nodeId: string } | undefined {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return;
  const safeLabel = sanitizeLinkLabel(label) || trimmedUrl;
  const index = getTreeIndex();
  const clicked = index.byId.get(nodeId);
  const targetId = clicked?.mirrorOf ?? nodeId;
  const node = index.byId.get(targetId);
  if (!node) return;
  const before = node.text;
  if (
    before !== range.source ||
    before.slice(range.start, range.end) !== oldToken
  )
    return;
  const wholeNode = before.trim() === oldToken.trim();
  if (
    display === "embed" &&
    (!wholeNode ||
      (node.kind !== null && node.kind !== "embed") ||
      (!getEditorFeatures().embeds && node.kind !== "embed") ||
      !embedResource(trimmedUrl))
  )
    return;
  const newToken =
    display === "link"
      ? `[${safeLabel}](${encodeUrlForMarkdown(trimmedUrl)})`
      : trimmedUrl;
  const text =
    before.slice(0, range.start) + newToken + before.slice(range.end);
  cancelNodeUnfurl(targetId);
  if (display === "embed" || node.kind === "embed") {
    if (!wholeNode) return;
    mutations.onSetKind(targetId, display === "embed" ? "embed" : null, text);
  } else if (text !== before) mutations.onTextChange(targetId, text);
  return { before, text, nodeId: targetId };
}

/** Mount the popover through the overlay host (the same thin `ctx.openOverlay`
 *  the tag color picker uses). Lives here so the plugin's index stays JSX-free. */
export function openLinkEditPopover(
  args: {
    nodeId: string;
    token: string;
    source: string;
    start: number;
    end: number;
    label: string;
    url: string;
    x: number;
    y: number;
    restoreFocus?: () => void;
  },
  ctx: PluginContext,
): void {
  const index = getTreeIndex();
  const clicked = index.byId.get(args.nodeId);
  const node = index.byId.get(clicked?.mirrorOf ?? args.nodeId);
  const standalone = node?.text.trim() === args.token.trim();
  const display: DisplayAs =
    node?.kind === "embed"
      ? "embed"
      : args.token.startsWith("[")
        ? "link"
        : "plain";
  const close = () => {
    ctx.openOverlay(null);
    requestAnimationFrame(() => {
      // An outside-pointerdown dismiss may have already focused another
      // bullet; restoring would steal the caret from where the user clicked.
      if (document.activeElement?.closest(".node-text")) return;
      args.restoreFocus?.();
    });
  };
  ctx.openOverlay(
    <LinkEditPopover
      label={args.label === args.url ? "" : args.label}
      url={args.url}
      x={args.x}
      y={args.y}
      display={display}
      canEmbed={standalone && (node?.kind === null || node?.kind === "embed")}
      mirrorCount={
        index.mirrorsBySource.get(node?.id ?? args.nodeId)?.length ?? 0
      }
      onSubmit={(label, url, display) => {
        const live = getTreeIndex().byId.get(node?.id ?? args.nodeId);
        if (live?.kind !== node?.kind) return;
        const write = submitLinkEdit(
          args.nodeId,
          args.token,
          label,
          url,
          ctx.mutations,
          display,
          args,
        );
        if (!write) return;
        if (display === "link" && (!label.trim() || label === url.trim()))
          unfurlNodeLinks(
            write.nodeId,
            write.before.slice(0, args.start) + write.before.slice(args.end),
            write.text,
            ctx,
          );
        if (
          display === "embed" &&
          getEditorFeatures().embeds &&
          !getEditorFeatures().externalEmbeds
        )
          queueMicrotask(() => requestPermission(ctx));
      }}
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
): { before: string; text: string } | undefined {
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
  if (next != null && next !== current) {
    mutations.onTextChange(args.nodeId, next);
    return { before: current, text: next };
  }
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
      onSubmit={(label, url) => {
        const write = submitLinkCreate(args, label, url, ctx.mutations);
        if (write) unfurlNodeLinks(args.nodeId, write.before, write.text, ctx);
      }}
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}

/**
 * The popover itself: anchored below the clicked pencil (fixed, clamped on
 * screen), dismissed on outside pointerdown or Escape, submitted on Done or
 * Enter. Opened through ctx.openOverlay (the same thin host as the tag color
 * picker), so it owns its own positioning + dismiss on desktop. Below 768px,
 * the shared native sheet owns gestures, keyboard accommodation and dismissal.
 */
export function LinkEditPopover({
  label: initialLabel,
  url: initialUrl,
  x,
  y,
  display: initialDisplay = "link",
  canEmbed = false,
  mirrorCount = 0,
  onSubmit,
  onClose,
}: {
  label: string;
  url: string;
  x: number;
  y: number;
  display?: DisplayAs;
  canEmbed?: boolean;
  mirrorCount?: number;
  onSubmit: (label: string, url: string, display: DisplayAs) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLFormElement | null>(null);
  const [label, setLabel] = useState(initialLabel);
  const [url, setUrl] = useState(initialUrl);
  const [display, setDisplay] = useState(initialDisplay);
  const mobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(true);
  const pendingSubmit = useRef<{
    label: string;
    url: string;
    display: DisplayAs;
  } | null>(null);
  const prefs = useEditorFeatures();
  const id = useId();
  const supportsEmbed = canEmbed && !!embedResource(url);
  const showChoices = prefs.ready && prefs.embeds && !!initialUrl;

  useDismissable(ref, onClose, !mobile);
  const close = () => {
    if (mobile) setSheetOpen(false);
    else onClose();
  };

  const left = Math.max(8, Math.min(x - 160, window.innerWidth - 328));
  const top = Math.max(
    8,
    Math.min(y, window.innerHeight - (showChoices ? 330 : 210)),
  );

  const form = (
    <form
      ref={ref}
      role={mobile ? undefined : "dialog"}
      aria-label={mobile ? undefined : "Edit link"}
      data-link-edit-popover
      className={
        mobile
          ? "flex flex-col gap-4"
          : "fixed z-50 flex max-h-[calc(100dvh-1rem)] w-80 max-w-[calc(100vw-1rem)] flex-col gap-3 overflow-y-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-md motion-safe:animate-in motion-safe:duration-100 motion-safe:fade-in-0 motion-safe:zoom-in-95"
      }
      style={
        mobile
          ? undefined
          : { left, top, transformOrigin: `${x - left}px ${y - 6 - top}px` }
      }
      onSubmit={(e) => {
        e.preventDefault();
        // Finish the native exit before a conversion opens its permission dialog.
        if (mobile) pendingSubmit.current = { label, url, display };
        else onSubmit(label, url, display);
        close();
      }}
    >
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>URL</FieldLabel>
          <Input
            id={`${id}-url`}
            className={mobile ? "min-h-11" : undefined}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Link URL"
            placeholder="https://…"
            inputMode="url"
            spellCheck={false}
            autoFocus={!mobile && display !== "link"}
          />
        </Field>
        {showChoices && (
          <Field>
            <FieldLabel id={`${id}-display`}>Display as</FieldLabel>
            <ToggleGroup
              aria-labelledby={`${id}-display`}
              value={[display]}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "link" || value === "plain" || value === "embed")
                  setDisplay(value);
              }}
              variant="outline"
              className="w-full"
              spacing={2}
            >
              <ToggleGroupItem
                value="link"
                className="h-16 min-w-0 flex-1 flex-col gap-1"
              >
                <HugeiconsIcon icon={Link01Icon} />
                Link Title
              </ToggleGroupItem>
              <ToggleGroupItem
                value="plain"
                className="h-16 min-w-0 flex-1 flex-col gap-1"
              >
                <HugeiconsIcon icon={TextIcon} />
                Plain URL
              </ToggleGroupItem>
              <ToggleGroupItem
                value="embed"
                disabled={!supportsEmbed}
                aria-describedby={
                  !supportsEmbed ? `${id}-embed-help` : undefined
                }
                className="h-16 min-w-0 flex-1 flex-col gap-1"
              >
                <HugeiconsIcon icon={LinkSquare02Icon} />
                Embed
              </ToggleGroupItem>
            </ToggleGroup>
            {!supportsEmbed && (
              <FieldDescription id={`${id}-embed-help`}>
                {canEmbed
                  ? "This URL doesn’t support embeds."
                  : "Embed needs a node with only one URL, without surrounding text."}
              </FieldDescription>
            )}
          </Field>
        )}
        <Field data-disabled={display !== "link"}>
          <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
          <Input
            id={`${id}-title`}
            className={mobile ? "min-h-11" : undefined}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Link text"
            placeholder="Use the page title"
            disabled={display !== "link"}
            autoFocus={!mobile && display === "link"}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
      </FieldGroup>
      {mirrorCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Changes all {mirrorCount + 1} instances
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={mobile ? "min-h-11" : undefined}
          onClick={close}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className={mobile ? "min-h-11" : undefined}
          disabled={
            !url.trim() ||
            (display === "embed" &&
              ((!prefs.embeds && initialDisplay !== "embed") || !supportsEmbed))
          }
        >
          Done
        </Button>
      </div>
    </form>
  );
  return mobile ? (
    <MenuSheetContent
      title="Edit link"
      compact
      isOpen={sheetOpen}
      onOpenChange={setSheetOpen}
      onAfterClose={() => {
        const draft = pendingSubmit.current;
        if (draft) onSubmit(draft.label, draft.url, draft.display);
        onClose();
      }}
    >
      {form}
    </MenuSheetContent>
  ) : (
    createPortal(form, document.body)
  );
}
