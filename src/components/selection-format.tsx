// The shared formatting surface for a text selection (ADR 0036, ADR 0069): the
// facade type, the button set, and the "is this selection a formatting target"
// read. The desktop floating toolbar and the mobile actions bar's format mode
// both render from FORMAT_BUTTONS, so the two can't drift apart.

import {
  BoldIcon,
  EyeOffIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnderlineIcon,
  type LucideIcon,
} from "lucide-react";

import { getSelectedAtom } from "./inline-code";
import {
  detectMarkerWrap,
  type MarkerPair,
  readActiveSelectionSource,
} from "./wrap";

/**
 * The zero-arg command surface both formatting surfaces drive. The facade
 * `useSelectionFormatActions` in OutlineEditor resolves the focused
 * (mirror-aware) content node internally, so the chrome stays dumb over the
 * existing emphasis/highlight/link machinery — no new mutation path, same
 * field-edit semantics as the keymap.
 */
export interface SelectionFormatActions {
  /** Toggle an emphasis marker (`**`, `*`, `~~`, `~`) over the selection. */
  toggleMarker: (marker: MarkerPair) => void;
  /** Toggle a default-blue highlight over the selection. */
  toggleHighlight: () => void;
  /** Wrap the selection in a link + open the edit form, or null when the
   *  links plugin isn't loaded. */
  createLink: (() => void) | null;
}

export const BOLD: MarkerPair = { pre: "**", post: "**" };
export const ITALIC: MarkerPair = { pre: "*", post: "*" };
export const STRIKE: MarkerPair = { pre: "~~", post: "~~" };
export const UNDER: MarkerPair = { pre: "~", post: "~" };
const HIGHLIGHT: MarkerPair = { pre: "==", post: "==" };
const SPOILER: MarkerPair = { pre: "||", post: "||" };

export interface FormatButton {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** Buttons in the same group sit together; a divider separates groups. */
  group: number;
  /** The marker whose wrap lights the button. Link is create-only, so none. */
  marker?: MarkerPair;
  /** The action, or null when it isn't available (link without the plugin). */
  action: (actions: SelectionFormatActions) => (() => void) | null;
}

const toggle =
  (marker: MarkerPair) =>
  (a: SelectionFormatActions): (() => void) =>
  () =>
    a.toggleMarker(marker);

/** The button set, in order. Spoiler is a plain marker (ADR 0043), so it rides
 *  `toggleMarker`; highlight strips its in-source color emoji on toggle-off
 *  (ADR 0035), so it has its own action but still lights via its fence. */
export const FORMAT_BUTTONS: readonly FormatButton[] = [
  {
    key: "bold",
    label: "Bold",
    Icon: BoldIcon,
    group: 0,
    marker: BOLD,
    action: toggle(BOLD),
  },
  {
    key: "italic",
    label: "Italic",
    Icon: ItalicIcon,
    group: 0,
    marker: ITALIC,
    action: toggle(ITALIC),
  },
  {
    key: "strike",
    label: "Strikethrough",
    Icon: StrikethroughIcon,
    group: 0,
    marker: STRIKE,
    action: toggle(STRIKE),
  },
  {
    key: "underline",
    label: "Underline",
    Icon: UnderlineIcon,
    group: 0,
    marker: UNDER,
    action: toggle(UNDER),
  },
  {
    key: "highlight",
    label: "Highlight",
    Icon: HighlighterIcon,
    group: 1,
    marker: HIGHLIGHT,
    action: (a) => a.toggleHighlight,
  },
  {
    key: "spoiler",
    label: "Spoiler",
    Icon: EyeOffIcon,
    group: 1,
    marker: SPOILER,
    action: toggle(SPOILER),
  },
  {
    key: "link",
    label: "Link",
    Icon: LinkIcon,
    group: 1,
    action: (a) => a.createLink,
  },
];

/** The `.node-text` contentEditable containing a DOM node, or null. Both an
 *  outline bullet and the zoomed title carry `.node-text`, so this is the honest
 *  "the selection is inside one editable outline span" test. */
function outlineSpanOf(node: Node): HTMLElement | null {
  // SAFETY: nodeType === 1 means the node is an Element, rendered here as HTMLElement
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  return el?.closest<HTMLElement>(".node-text") ?? null;
}

export interface FormatTarget {
  rect: DOMRect;
  /** The button keys whose marker already wraps the selection (lit buttons). */
  active: Set<string>;
}

/** The current selection as a formatting target, or null when it isn't one: no
 *  selection, collapsed, spanning more than one bullet (a cross-bullet range
 *  can't be wrapped in source), or exactly one folded atom (a chip can't be
 *  source-wrapped). */
export function readFormatTarget(): FormatTarget | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const host = outlineSpanOf(range.startContainer);
  if (!host || !host.isContentEditable) return null;
  if (outlineSpanOf(range.endContainer) !== host) return null;
  if (getSelectedAtom(host)) return null;

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;

  const active = new Set<string>();
  const src = readActiveSelectionSource();
  if (src) {
    for (const b of FORMAT_BUTTONS) {
      if (
        b.marker &&
        detectMarkerWrap(src.source, src.start, src.end, b.marker)
      )
        active.add(b.key);
    }
  }
  return { rect, active };
}
