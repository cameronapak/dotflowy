// Shared OPML export core (ADR 0037): a TreeIndex scope -> one OPML string in
// the Workflowy dialect (`text` with escaped inline HTML, `_complete`
// present-iff-true, `&#10;` newlines) plus dotflowy's invented extensions
// (`_task`, and the mirror dialect: `id` on in-scope mirror sources,
// `_mirror="<sourceId>"` on mirror roots over a fully resolved duplicate).
// Both surfaces — the app's export action and the MCP `export_opml` tool —
// serialize through THIS module, the wire-schema.ts shared-leaf precedent.
//
// The serializer is hand-rolled on purpose (~30 lines: escape `& < > " '`,
// newlines as `&#10;` in attributes) — the output shape stays fully under our
// control, and Workflowy imports it cleanly (live-verified, ADR 0037).
// Content, never state: `collapsed`, `bookmarkedAt`, `origin`, and timestamps
// are deliberately dropped.
//
// Pure leaf: imports only the pure token layers (plus the route-bible pure
// module, the markdown.ts precedent) — no DOM globals, no workers types.

import { bibleRefsToMarkdownLinks } from "../plugins/route-bible/bible";
import { DATE_LINK_PATTERN, parseDateLink } from "./date-links";
import {
  BOLD_PATTERN,
  ITALIC_PATTERN,
  ITALIC_UNDERSCORE_PATTERN,
  STRIKETHROUGH_PATTERN,
  UNDERLINE_PATTERN,
  emphasisMarkerLen,
} from "./emphasis";
import {
  HIGHLIGHT_PATTERN,
  parseHighlight,
  type HighlightColor,
} from "./highlight";
import { LINK_PATTERN, sanitizeLinkLabel } from "./links";
import { NODE_LINK_PATTERN, linkTargetId, linkedNodeLabel } from "./node-links";
import { childrenOf, trueSourceOf, type TreeIndex } from "./tree";

/** Where a `[[nodeId]]` link resolves for the export projection. Derives from
 *  one place instead of being scattered as literals (ADR 0037). */
export const DEFAULT_APP_ORIGIN = "https://app.dotflowy.com";

export interface OpmlExportOptions {
  /** `<head><title>` — the ONLY head element (no `ownerEmail`: a privacy leak
   *  in a shareable file, ADR 0037). */
  title: string;
  /** Origin for node-link `<a href>` projections. */
  appOrigin?: string;
}

// --- Escaping -------------------------------------------------------------------
// Export mirrors the two-layer decode in reverse (ADR 0037): compose the
// inline HTML first (content HTML-escaped), then XML-escape the whole
// attribute value — so a literal `<` in node.text lands as `&amp;lt;`,
// byte-matching Workflowy's own output.

/** Layer 1 (inner): escape text that becomes HTML *content* or an HTML
 *  attribute value inside the composed rich-text string. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Layer 2 (outer): escape a whole XML attribute value. Newlines become
 *  `&#10;` — the dialect's only numeric reference. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "&#10;");
}

/** XML element text content (the `<title>`). */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Inline projection: dotflowy tokens -> Workflowy HTML --------------------------
// The exact inverse of the import table (#114), plus the dotflowy-only
// projections (node links, Bible refs). One combined scan in registry
// precedence order — alternation order mirrors the token registry, so the
// export tokenizes a line exactly as the editor renders it. Text that didn't
// tokenize stays plain (never invent markup for literal `*`/`~`/`[`).

const CODE_RUN_PATTERN = "`[^`\\n]+`";

/** Alternation in ascending registry precedence: links 0 < node-links 5 <
 *  date 6 < code 10 < bold 30 < strike 31 < italic 32 < underline 33 <
 *  underscore-italic 34 < highlight 35. (Bible refs, precedence 15, are
 *  pre-projected to markdown links before this scan — the markdown.ts
 *  precedent — so the LINK branch handles them.) Built per call: a `g` regex
 *  carries `lastIndex`. */
function tokenRegex(): RegExp {
  return new RegExp(
    [
      LINK_PATTERN,
      NODE_LINK_PATTERN,
      DATE_LINK_PATTERN,
      CODE_RUN_PATTERN,
      BOLD_PATTERN,
      STRIKETHROUGH_PATTERN,
      ITALIC_PATTERN,
      UNDERLINE_PATTERN,
      ITALIC_UNDERSCORE_PATTERN,
      HIGHLIGHT_PATTERN,
    ].join("|"),
    "gu",
  );
}

const MD_LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

/** dotflowy highlight color -> the nearest OBSERVED Workflowy background
 *  class (blue -> `bc-sky`; the leading circle emoji is encoding, not
 *  content, and is stripped). Text-color provenance (`c-*`) is never
 *  reconstructed — everything exports as `bc-*` (ADR 0037). */
const HIGHLIGHT_CLASS: Record<HighlightColor, string> = {
  red: "bc-red",
  orange: "bc-orange",
  yellow: "bc-yellow",
  green: "bc-green",
  blue: "bc-sky",
  purple: "bc-purple",
};

const WEEKDAYS_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `<time>` display text regenerated from the canonical date — Workflowy's
 *  own shape ("Wed, Jul 8, 2026", "… at 1:00pm"). Deterministic English: the
 *  Worker has no user locale, and Workflowy rebuilds its pill from the
 *  ATTRIBUTES anyway (the display text is redundant, #112). */
function formatTimeDisplay(key: string, time: string | null): string {
  const [y, mo, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, 12));
  let display = `${WEEKDAYS_SHORT[date.getUTCDay()]}, ${MONTHS_SHORT[mo - 1]} ${d}, ${y}`;
  if (time !== null) {
    const [hh, mm] = time.split(":").map(Number) as [number, number];
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    display += ` at ${h12}:${String(mm).padStart(2, "0")}${hh < 12 ? "am" : "pm"}`;
  }
  return display;
}

/** The ADR 0038 date token -> `<time start…>display</time>` — a TRUE
 *  round-trip: Workflowy rebuilds a live pill from the attrs, and our import
 *  rebuilds the token. Attrs are unpadded, matching Workflowy's serializer;
 *  `startMinute` is emitted only when non-zero (the dialect omits it for :00). */
function dateTokenToTime(tok: string): string | null {
  const parsed = parseDateLink(tok);
  if (!parsed) return null;
  const [y, mo, d] = parsed.key.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  let attrs = ` startYear="${y}" startMonth="${mo}" startDay="${d}"`;
  if (parsed.time !== null) {
    const [hh, mm] = parsed.time.split(":").map(Number) as [number, number];
    attrs += ` startHour="${hh}"`;
    if (mm !== 0) attrs += ` startMinute="${mm}"`;
  }
  return `<time${attrs}>${escapeHtml(formatTimeDisplay(parsed.key, parsed.time))}</time>`;
}

function tokenToHtml(tok: string, index: TreeIndex, appOrigin: string): string {
  // `[[…]]` family first: date-shaped and id-shaped interiors are disjoint.
  if (tok.startsWith("[[")) {
    const asTime = dateTokenToTime(tok);
    if (asTime !== null) return asTime;
    // Node link -> an app URL with the target's flattened text as the label
    // (one level deep; a missing target keeps the id so nothing is lost).
    const targetId = linkTargetId(tok);
    const target = index.byId.get(targetId);
    const label = target
      ? sanitizeLinkLabel(linkedNodeLabel(target.text)) || targetId
      : targetId;
    return `<a href="${escapeHtml(`${appOrigin}/${targetId}`)}">${escapeHtml(label)}</a>`;
  }
  if (tok.startsWith("[")) {
    const m = MD_LINK_RE.exec(tok);
    if (!m) return escapeHtml(tok);
    return `<a href="${escapeHtml(m[2] ?? "")}">${escapeHtml(m[1] ?? "")}</a>`;
  }
  if (tok.startsWith("==")) {
    const { color, interior } = parseHighlight(tok);
    return `<mark class="colored ${HIGHLIGHT_CLASS[color]}">${escapeHtml(interior)}</mark>`;
  }
  if (tok.startsWith("`")) {
    return `<code>${escapeHtml(tok.slice(1, -1))}</code>`;
  }
  // Emphasis: same marker char both edges, length 1 or 2.
  const markerLen = emphasisMarkerLen(tok);
  if (markerLen === 0) return escapeHtml(tok); // defensive — patterns always match
  const interior = escapeHtml(tok.slice(markerLen, tok.length - markerLen));
  const marker = tok.slice(0, markerLen);
  if (marker === "**") return `<b>${interior}</b>`;
  if (marker === "~~") return `<s>${interior}</s>`;
  if (marker === "~") return `<u>${interior}</u>`;
  // `*` and the render-only `_` alias both export as italic (#114).
  return `<i>${interior}</i>`;
}

/** One node's `text` -> the composed inline-HTML string (NOT yet
 *  XML-escaped). `#tags` are plain text in Workflowy — direct pass-through. */
function projectText(
  text: string,
  index: TreeIndex,
  appOrigin: string,
): string {
  // Bible refs become ordinary markdown links first (resolve-or-literal with
  // link/code ranges protected — reuses the shipped markdown-export path).
  const source = bibleRefsToMarkdownLinks(text);
  const re = tokenRegex();
  let out = "";
  let last = 0;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m.index > last) out += escapeHtml(source.slice(last, m.index));
    out += tokenToHtml(m[0], index, appOrigin);
    last = re.lastIndex;
  }
  if (last < source.length) out += escapeHtml(source.slice(last));
  return out;
}

// --- The scope walk + serializer ------------------------------------------------------

const INDENT = "  ";

interface ExportState {
  index: TreeIndex;
  appOrigin: string;
  /** In-scope mirror sources that need an `id` attribute. */
  sourcesNeedingId: ReadonlySet<string>;
  lines: string[];
}

/**
 * Emit one node at `depth`. `inExpansion` is true inside a mirror's resolved
 * duplicate: those rows are interchange filler (Workflowy sees a plain copy),
 * so they carry no `id`/`_mirror` attrs. `sourcesOnPath` caps mirror cycles —
 * a mirror whose source is already an ancestor on this path emits its
 * resolved text but no children (the flattenSubtree rule).
 */
function emitNode(
  state: ExportState,
  id: string,
  depth: number,
  sourcesOnPath: ReadonlySet<string>,
  inExpansion: boolean,
): void {
  const { index } = state;
  const node = index.byId.get(id);
  if (!node) return;
  const contentId = trueSourceOf(index, id);
  const content = index.byId.get(contentId) ?? node;
  const isMirror = node.mirrorOf !== null;
  const capped = isMirror && sourcesOnPath.has(contentId);

  let attrs = "";
  if (content.completed) attrs += ' _complete="true"';
  if (content.isTask) attrs += ' _task="true"';
  if (!inExpansion) {
    if (state.sourcesNeedingId.has(id)) attrs += ` id="${escapeXmlAttr(id)}"`;
    if (isMirror) attrs += ` _mirror="${escapeXmlAttr(contentId)}"`;
  }
  attrs += ` text="${escapeXmlAttr(projectText(content.text, index, state.appOrigin))}"`;

  const children = capped ? [] : childrenOf(index, contentId);
  const pad = INDENT.repeat(depth + 2); // inside <opml><body>
  if (children.length === 0) {
    state.lines.push(`${pad}<outline${attrs} />`);
    return;
  }
  state.lines.push(`${pad}<outline${attrs}>`);
  const nextSources = new Set(sourcesOnPath);
  nextSources.add(contentId);
  for (const child of children) {
    emitNode(state, child.id, depth + 1, nextSources, inExpansion || isMirror);
  }
  state.lines.push(`${pad}</outline>`);
}

/** Own-position pass: which node ids are in scope, and which of them are the
 *  true source of an in-scope mirror. A mirror's expansion is NOT an own
 *  position, so the walk doesn't descend into it. */
function collectScope(
  index: TreeIndex,
  rootIds: readonly string[],
): { scopeIds: Set<string>; mirrorSources: Set<string> } {
  const scopeIds = new Set<string>();
  const mirrorSources = new Set<string>();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop()!;
    const node = index.byId.get(id);
    if (!node || scopeIds.has(id)) continue;
    scopeIds.add(id);
    if (node.mirrorOf !== null) {
      mirrorSources.add(trueSourceOf(index, id));
      continue;
    }
    for (const child of childrenOf(index, id)) stack.push(child.id);
  }
  return { scopeIds, mirrorSources };
}

/**
 * Serialize a scope — the zoom root's subtree (root INCLUDED), or the whole
 * outline for a null root — to one OPML 2.0 string in the Workflowy dialect.
 * `<head>` is `<title>` only. View state (`collapsed`, filters) never reaches
 * here: content, never state (ADR 0037).
 */
export function exportOpml(
  index: TreeIndex,
  rootId: string | null,
  options: OpmlExportOptions,
): string {
  const appOrigin = options.appOrigin ?? DEFAULT_APP_ORIGIN;
  const rootIds =
    rootId === null ? childrenOf(index, null).map((n) => n.id) : [rootId];

  const { scopeIds, mirrorSources } = collectScope(index, rootIds);
  const sourcesNeedingId = new Set<string>();
  for (const sourceId of mirrorSources) {
    if (scopeIds.has(sourceId)) sourcesNeedingId.add(sourceId);
  }

  const state: ExportState = { index, appOrigin, sourcesNeedingId, lines: [] };
  for (const id of rootIds) emitNode(state, id, 0, new Set(), false);

  return [
    '<?xml version="1.0"?>',
    '<opml version="2.0">',
    "  <head>",
    `    <title>${escapeXmlText(options.title)}</title>`,
    "  </head>",
    "  <body>",
    ...state.lines,
    "  </body>",
    "</opml>",
  ].join("\n");
}
