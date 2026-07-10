// Shared OPML import core (ADR 0037): OPML source -> intermediate forest ->
// `ChangeOp[]` plan. The wire-schema.ts shared-leaf precedent, import
// direction: BOTH the app UI dialog and the Worker MCP `import_opml` tool
// consume THIS module, so the mapping, the degradation counting, and the
// ceiling can never drift between the two surfaces. It imports only pure
// leaves (`effect`, `@rgrove/parse-xml`, and the pure `src/data` token
// layers) — no DOM globals, no workers types — so it compiles under the app,
// worker, and test tsconfigs and runs under plain `bun test`.
//
// The fidelity bar is "degraded, never silent" (ADR 0037): content survives
// byte-exact, presentation may shift, and every shift lands in the typed
// {@link OpmlImportReport} the app dialog and the MCP receipt both disclose.
// The mapping is the one the fidelity probe (docs/spec-assets/opml/
// fidelity-probe.ts) validated against a real 16,882-node Workflowy export —
// zero content-loss violations. The degradation message strings are kept
// byte-compatible with the probe's report so counts stay comparable.

import { parseXml, XmlElement, XmlError } from "@rgrove/parse-xml";
import { Data, Effect } from "effect";

import type { ChangeOp } from "./wire-schema";

import { isValidDateKey } from "./date-links";
import { buildHighlightRun, type HighlightColor } from "./highlight";
import { encodeUrlForMarkdown, sanitizeLinkLabel } from "./links";
import { makeNode, type NodeKind } from "./tree";

// --- Typed failures -----------------------------------------------------------

/** The document is not well-formed XML (or not OPML at all). Carries the
 *  parser's line/column when it has one — truncation always does, which is the
 *  whole point of the chosen parser (ADR 0037: fail loudly, never a silent
 *  partial tree). */
export class OpmlParseError extends Data.TaggedError("OpmlParseError")<{
  reason: string;
  line: number | null;
  column: number | null;
}> {
  get message() {
    return this.line !== null
      ? `${this.reason} (line ${this.line}, column ${this.column})`
      : this.reason;
  }
}

/** Raw input over the byte ceiling — rejected BEFORE parsing so a hostile or
 *  runaway file never reaches the parser. */
export class OpmlTooLarge extends Data.TaggedError("OpmlTooLarge")<{
  length: number;
  maxLength: number;
}> {
  get message() {
    return `OPML input is too large: ${this.length} > ${this.maxLength} characters`;
  }
}

/** The post-split node count is over the caller's ceiling (app 50k / MCP 5k —
 *  the ceiling is a parameter, the counting is shared). */
export class OpmlImportTooLarge extends Data.TaggedError("OpmlImportTooLarge")<{
  count: number;
  max: number;
}> {
  get message() {
    return `too many nodes to import: ${this.count} exceeds the ${this.max}-node ceiling`;
  }
}

/** The document parsed but holds zero `<outline>` nodes — nothing to import. */
export class OpmlEmpty extends Data.TaggedError("OpmlEmpty")<
  Record<never, never>
> {
  get message() {
    return "the OPML document contains no outline nodes";
  }
}

/** ~20 MB of UTF-16 units. The real 17k-node Workflowy export is ~2 MB, so
 *  this is a 10x safety margin, not a product limit — the node ceiling in
 *  {@link planOpmlImport} is the real bound. */
export const DEFAULT_MAX_OPML_LENGTH = 20 * 1024 * 1024;

/** App-UI import ceiling: 50,000 post-split nodes (ADR 0037). */
export const OPML_APP_MAX_NODES = 50_000;
/** MCP `import_opml` ceiling: 5,000 post-split nodes (ADR 0037). */
export const OPML_MCP_MAX_NODES = 5_000;

// --- The intermediate forest + report -------------------------------------------

/** One imported node, post note-splitting, pre id-minting. */
export interface OpmlImportNode {
  text: string;
  completed: boolean;
  isTask: boolean;
  /** `"paragraph"` from a `_kind="paragraph"` attribute (ADR 0045); null (a
   *  bullet-or-task) for any other value, and for foreign OPML that has none. */
  kind: NodeKind;
  /** The document's `id` attribute (the dotflowy mirror dialect), if any. */
  opmlId: string | null;
  /** An in-document `id` this node mirrors (`_mirror` resolved against the
   *  document's `id` set), or null. When set, `children` is empty — the
   *  exported duplicate subtree belongs to the source and is dropped on
   *  re-link. An UNRESOLVED `_mirror` imports as a detached plain copy
   *  (children kept, counted in the report). */
  mirrorOfOpmlId: string | null;
  children: OpmlImportNode[];
}

/** The typed degradation tally both disclosure surfaces render (the app's
 *  confirm dialog and the MCP receipt). `degraded` keys are stable
 *  human-readable messages (byte-compatible with the fidelity probe's). */
export interface OpmlImportReport {
  /** `<outline>` elements in the document. */
  nodesPre: number;
  /** Forest nodes after note/newline splitting — what the ceiling counts. */
  nodesPost: number;
  emptyText: number;
  /** `_note` attributes converted (the counted #113 degradation)… */
  notes: number;
  /** …and the child bullets they became. */
  noteLines: number;
  noteBlanksDropped: number;
  /** `&#10;` inside `text` -> continuation child bullets. */
  textNewlineSplits: number;
  mirrorsLinked: number;
  mirrorsDetached: number;
  /** Degradation message -> count. Empty object = full-fidelity import. */
  degraded: Record<string, number>;
  degradedTotal: number;
  /** Malformed-inline-HTML anomalies TOLERATED (text always kept): stray close
   *  tags ignored, unclosed tags auto-closed. Real Workflowy exports contain
   *  these (cross-bullet `<b>` spans), so they are not errors. */
  anomalies: Record<string, number>;
  /** Attribute names outside the known dialect, with counts — the loss-report
   *  candidates surface. */
  unknownAttributes: Record<string, number>;
}

export interface OpmlImportResult {
  forest: OpmlImportNode[];
  report: OpmlImportReport;
}

// --- Counters -------------------------------------------------------------------

class Tally {
  readonly map = new Map<string, number>();
  bump(key: string, n = 1): void {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
  }
  toRecord(): Record<string, number> {
    const entries = [...this.map.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return Object.fromEntries(entries);
  }
  total(): number {
    let n = 0;
    for (const v of this.map.values()) n += v;
    return n;
  }
}

// --- Layer 2: HTML entity decode --------------------------------------------------
// The attribute value is HTML *inside* XML. The XML parser decoded layer 1; the
// text segments the scanner slices out still carry HTML entities that are
// CONTENT (a user-typed literal `<` arrives as `&amp;lt;` -> `&lt;` after the
// XML decode -> `<` here). The two layers must never be conflated (ADR 0037).

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

// --- Tolerant inline-HTML scanner --------------------------------------------------
// NEVER rejects: real Workflowy exports contain malformed cross-bullet `<b>`
// spans (probe-verified — 3 unclosed `<b>` + 3 stray `</b>` in the real
// export). Stray close tags are ignored, unclosed tags auto-close at end of
// value, and text is ALWAYS kept; each tolerance is counted in `anomalies`.

type HtmlNode =
  | { kind: "text"; value: string }
  | {
      kind: "el";
      tag: string;
      attrs: Record<string, string>;
      children: HtmlNode[];
    };

const TAG_RE =
  /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

interface ScanFrame {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

function parseInlineHtml(src: string, anomalies: Tally): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: ScanFrame[] = [];
  const top = (): HtmlNode[] =>
    stack.length ? stack[stack.length - 1]!.children : root;
  const popFrame = (): void => {
    const frame = stack.pop()!;
    top().push({
      kind: "el",
      tag: frame.tag,
      attrs: frame.attrs,
      children: frame.children,
    });
  };

  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
    if (m.index > last) {
      top().push({
        kind: "text",
        value: decodeHtmlEntities(src.slice(last, m.index)),
      });
    }
    last = TAG_RE.lastIndex;
    const [, close, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag!.toLowerCase();
    if (close) {
      const i = stack.map((f) => f.tag).lastIndexOf(tag);
      if (i === -1) {
        anomalies.bump(`stray </${tag}>`);
        continue;
      }
      while (stack.length > i + 1) {
        anomalies.bump(`auto-closed <${stack[stack.length - 1]!.tag}>`);
        popFrame();
      }
      popFrame();
    } else {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      for (
        let a = ATTR_RE.exec(rawAttrs ?? "");
        a;
        a = ATTR_RE.exec(rawAttrs ?? "")
      ) {
        attrs[a[1]!] = decodeHtmlEntities(a[2] ?? a[3] ?? "");
      }
      if (selfClose) top().push({ kind: "el", tag, attrs, children: [] });
      else stack.push({ tag, attrs, children: [] });
    }
  }
  if (last < src.length) {
    top().push({ kind: "text", value: decodeHtmlEntities(src.slice(last)) });
  }
  while (stack.length) {
    anomalies.bump(`unclosed <${stack[stack.length - 1]!.tag}>`);
    popFrame();
  }
  return root;
}

function flattenText(nodes: HtmlNode[]): string {
  let out = "";
  for (const n of nodes) {
    out += n.kind === "text" ? n.value : flattenText(n.children);
  }
  return out;
}

function containsTag(nodes: HtmlNode[], tag: string): boolean {
  return nodes.some(
    (n) => n.kind === "el" && (n.tag === tag || containsTag(n.children, tag)),
  );
}

// --- HTML tree -> dotflowy token string ---------------------------------------------
// The locked #114 mapping. Interiors that would break a token pattern (the
// marker char, `=`/newline in a highlight) drop the formatting and keep the
// text; nesting flattens to outermost-wins with links trumping everything; a
// `<time>` with canonical attrs becomes the date token (ADR 0038 — adopted,
// not degraded); unknown tags strip to inner text. Every drop is counted.

interface MarkerSpec {
  open: string;
  close: string;
  forbid: RegExp;
}

const FORMAT_MARKERS: Record<string, MarkerSpec> = {
  b: { open: "**", close: "**", forbid: /[*\n]/ },
  i: { open: "*", close: "*", forbid: /[*\n]/ },
  u: { open: "~", close: "~", forbid: /[~\n]/ },
  s: { open: "~~", close: "~~", forbid: /[~\n]/ },
  code: { open: "`", close: "`", forbid: /[`\n]/ },
};

/** Workflowy palette name -> dotflowy highlight color. `teal`->green and
 *  `sky`/`pink` fold to their nearest neighbors; gray/brown have NO mapping
 *  (the shipped ADR 0035 palette has no white emoji — probe amendment) and
 *  degrade to the bare default-blue run. */
const MARK_COLOR: Record<string, HighlightColor> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "green",
  sky: "blue",
  blue: "blue",
  purple: "purple",
  pink: "purple",
};

interface ConvertState {
  degraded: Tally;
  /** Already inside a formatting tag — dotflowy emphasis is FLAT (ADR 0025). */
  insideFormat: boolean;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `<time start…>` -> the ADR 0038 date token, keyed on the CANONICAL
 *  attributes (never the display text). Returns null when the attrs are
 *  missing or don't name a real calendar day — the caller keeps the display
 *  text and counts the degradation. */
function timeToDateToken(attrs: Record<string, string>): string | null {
  const y = Number(attrs["startYear"]);
  const mo = Number(attrs["startMonth"]);
  const d = Number(attrs["startDay"]);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d))
    return null;
  const key = `${String(y).padStart(4, "0")}-${pad2(mo)}-${pad2(d)}`;
  if (!isValidDateKey(key)) return null;
  const hourRaw = attrs["startHour"];
  if (hourRaw === undefined) return `[[${key}]]`;
  const hour = Number(hourRaw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return `[[${key}]]`;
  const minute = Number(attrs["startMinute"] ?? "0");
  const mm =
    Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0;
  return `[[${key} ${pad2(hour)}:${pad2(mm)}]]`;
}

function convert(nodes: HtmlNode[], state: ConvertState): string {
  let out = "";
  for (const n of nodes) {
    out += n.kind === "text" ? n.value : convertEl(n, state);
  }
  return out;
}

function convertEl(
  el: Extract<HtmlNode, { kind: "el" }>,
  state: ConvertState,
): string {
  const { degraded } = state;
  switch (el.tag) {
    case "a": {
      const rawLabel = flattenText(el.children);
      // Formatting INSIDE a link is dropped — a working link beats any styling
      // (in the combined token regex `**[l](u)**` would tokenize as bold and
      // kill the link).
      const walkInner = (nodes: HtmlNode[]): void => {
        for (const n of nodes) {
          if (n.kind === "el") {
            degraded.bump(`styling inside <a> dropped (<${n.tag}>)`);
            walkInner(n.children);
          }
        }
      };
      walkInner(el.children);
      const url = encodeUrlForMarkdown(el.attrs["href"] ?? "");
      const label = sanitizeLinkLabel(rawLabel);
      if (label !== rawLabel.trim() || rawLabel.includes("]")) {
        degraded.bump(
          "link label sanitized (`]` stripped / whitespace collapsed)",
        );
      }
      return `[${label}](${url})`;
    }
    case "time": {
      // Adopted, not degraded (ADR 0038) — but only where the token can
      // actually render: inside a formatting run the interior is plain text,
      // so the display text is the honest fallback there.
      const display = flattenText(el.children);
      if (state.insideFormat) {
        degraded.bump("<time> inside formatting -> display text kept");
        return display;
      }
      const token = timeToDateToken(el.attrs);
      if (token === null) {
        degraded.bump(
          "<time> missing canonical start attrs -> display text kept",
        );
        return display;
      }
      return token;
    }
    case "mention": {
      const id = el.attrs["id"] ?? "?";
      degraded.bump("<mention> -> @mention(id) (name unrecoverable)");
      return `@mention(${id})`;
    }
    case "b":
    case "i":
    case "u":
    case "s":
    case "code": {
      const spec = FORMAT_MARKERS[el.tag]!;
      if (containsTag(el.children, "a")) {
        degraded.bump(`<${el.tag}> dropped: contains a link (link wins)`);
        return convert(el.children, state);
      }
      if (state.insideFormat) {
        degraded.bump(`nested <${el.tag}> dropped (outermost wins)`);
        return convert(el.children, state);
      }
      const interior = convert(el.children, { ...state, insideFormat: true });
      if (interior.length === 0) {
        degraded.bump(`empty <${el.tag}> dropped`);
        return "";
      }
      if (spec.forbid.test(interior)) {
        degraded.bump(`<${el.tag}> dropped: marker char in interior`);
        return interior;
      }
      return spec.open + interior + spec.close;
    }
    case "mark": {
      if (containsTag(el.children, "a")) {
        degraded.bump("<mark> dropped: contains a link (link wins)");
        return convert(el.children, state);
      }
      if (state.insideFormat) {
        degraded.bump("nested <mark> dropped (outermost wins)");
        return convert(el.children, state);
      }
      const interior = convert(el.children, { ...state, insideFormat: true });
      if (interior.length === 0) {
        degraded.bump("empty <mark> dropped");
        return "";
      }
      if (/[=\n]/.test(interior)) {
        degraded.bump("<mark> dropped: `=` or newline in interior");
        return interior;
      }
      // `c-*` (text color) and `bc-*` (background) both map to a highlight —
      // parse the prefix liberally rather than allowlisting names (#112).
      const cls = el.attrs["class"] ?? "";
      const colorName = /(?:^|\s)(?:c|bc)-([a-z]+)/.exec(cls)?.[1];
      const color = colorName ? MARK_COLOR[colorName] : undefined;
      if (colorName && color === undefined) {
        if (colorName === "gray" || colorName === "brown") {
          degraded.bump(
            `<mark ${colorName}> -> bare == (no white in the palette)`,
          );
        } else {
          degraded.bump(`<mark ${colorName}> unrecognized -> bare ==`);
        }
      }
      // buildHighlightRun canonicalizes: blue (the default) emits the BARE
      // `==x==` form, so a `bc-sky` import round-trips as clean markdown.
      return buildHighlightRun(color ?? "blue", interior);
    }
    default: {
      degraded.bump(`unknown <${el.tag}> stripped, text kept`);
      return convert(el.children, state);
    }
  }
}

// --- <outline> walk -----------------------------------------------------------------

/** The complete known attribute set: Workflowy's three + the dotflowy export
 *  dialect's four (ADR 0037 mirror persistence + `_task`, ADR 0045 `_kind`). */
const KNOWN_ATTRS = new Set([
  "text",
  "_note",
  "_complete",
  "_task",
  "_kind",
  "id",
  "_mirror",
]);

interface MapState {
  degraded: Tally;
  anomalies: Tally;
  unknownAttrs: Tally;
  nodesPre: number;
  emptyText: number;
  notes: number;
  noteLines: number;
  noteBlanksDropped: number;
  textNewlineSplits: number;
  mirrorsLinked: number;
  mirrorsDetached: number;
  /** Every `id` attribute in the document — the `_mirror` resolution set. */
  documentIds: ReadonlySet<string>;
}

function convertValue(
  raw: string,
  state: MapState,
): { text: string; extraLines: string[] } {
  const tree = parseInlineHtml(raw, state.anomalies);
  const converted = convert(tree, {
    degraded: state.degraded,
    insideFormat: false,
  });
  const lines = converted.split("\n");
  return { text: lines[0] ?? "", extraLines: lines.slice(1) };
}

function isOutline(child: unknown): child is XmlElement {
  return child instanceof XmlElement && child.name === "outline";
}

function collectDocumentIds(el: XmlElement, into: Set<string>): void {
  const id = el.attributes["id"];
  if (id) into.add(id);
  for (const child of el.children) {
    if (isOutline(child)) collectDocumentIds(child, into);
  }
}

function convertOutline(el: XmlElement, state: MapState): OpmlImportNode {
  state.nodesPre++;
  for (const name of Object.keys(el.attributes)) {
    if (!KNOWN_ATTRS.has(name)) state.unknownAttrs.bump(name);
  }

  const rawText = el.attributes["text"] ?? "";
  if (rawText === "") state.emptyText++;
  const { text, extraLines } = convertValue(rawText, state);

  // `&#10;` continuation lines in `text` become child bullets BEFORE any
  // `_note`-derived lines (#114); blank continuations are formatting, dropped.
  const prepend: OpmlImportNode[] = [];
  if (extraLines.length) {
    state.textNewlineSplits++;
    for (const line of extraLines) {
      if (line.trim() !== "") prepend.push(plainNode(line));
    }
  }

  // `_note` -> prepended child bullets, one per non-blank line, order kept
  // (#113). The trailing serializer `&#10;` shows up as a blank line and is
  // dropped with the rest.
  const noteRaw = el.attributes["_note"];
  if (noteRaw !== undefined) {
    state.notes++;
    const { text: first, extraLines: rest } = convertValue(noteRaw, state);
    for (const line of [first, ...rest]) {
      if (line.trim() === "") state.noteBlanksDropped++;
      else {
        prepend.push(plainNode(line));
        state.noteLines++;
      }
    }
  }

  const completed = el.attributes["_complete"] === "true";
  const isTask = el.attributes["_task"] === "true";
  // Absent (foreign OPML, and every export that predates ADR 0045) = a bullet.
  // An unrecognized value reads as a bullet too, never as a decode failure.
  const kind: NodeKind =
    el.attributes["_kind"] === "paragraph" ? "paragraph" : null;
  const opmlId = el.attributes["id"] || null;

  // Mirror re-link (ADR 0037): a `_mirror` referencing an in-document `id`
  // becomes a REAL mirror — its exported duplicate subtree belongs to the
  // source and is dropped. An unresolvable `_mirror` (the source is outside
  // this document, or the OPML passed through Workflowy, which strips the
  // attrs) imports as a detached plain copy — disclosed, never silent.
  const mirrorRef = el.attributes["_mirror"];
  if (mirrorRef !== undefined && state.documentIds.has(mirrorRef)) {
    state.mirrorsLinked++;
    return {
      text,
      completed,
      isTask,
      kind,
      opmlId,
      mirrorOfOpmlId: mirrorRef,
      children: [],
    };
  }
  if (mirrorRef !== undefined) {
    state.mirrorsDetached++;
    state.degraded.bump("mirror detached (source not in this document)");
  }

  const realChildren: OpmlImportNode[] = [];
  for (const child of el.children) {
    if (isOutline(child)) realChildren.push(convertOutline(child, state));
  }
  return {
    text,
    completed,
    isTask,
    kind,
    opmlId,
    mirrorOfOpmlId: null,
    children: [...prepend, ...realChildren],
  };
}

function plainNode(text: string): OpmlImportNode {
  return {
    text,
    completed: false,
    isTask: false,
    // A `_note` / continuation line becomes a plain bullet, never a paragraph:
    // the attribute belongs to the outline element, not to its spilled lines.
    kind: null,
    opmlId: null,
    mirrorOfOpmlId: null,
    children: [],
  };
}

function countForest(forest: readonly OpmlImportNode[]): number {
  let n = 0;
  const stack = [...forest];
  while (stack.length) {
    const node = stack.pop()!;
    n++;
    for (const child of node.children) stack.push(child);
  }
  return n;
}

function mapDocument(source: string): OpmlImportResult {
  const doc = parseXml(source);
  const opml = doc.children.find(
    (c): c is XmlElement => c instanceof XmlElement && c.name === "opml",
  );
  const body = opml?.children.find(
    (c): c is XmlElement => c instanceof XmlElement && c.name === "body",
  );
  if (!body) {
    throw new OpmlParseError({
      reason: "not an OPML document (missing <opml>/<body>)",
      line: null,
      column: null,
    });
  }
  const tops = body.children.filter(isOutline);

  const documentIds = new Set<string>();
  for (const el of tops) collectDocumentIds(el, documentIds);

  const state: MapState = {
    degraded: new Tally(),
    anomalies: new Tally(),
    unknownAttrs: new Tally(),
    nodesPre: 0,
    emptyText: 0,
    notes: 0,
    noteLines: 0,
    noteBlanksDropped: 0,
    textNewlineSplits: 0,
    mirrorsLinked: 0,
    mirrorsDetached: 0,
    documentIds,
  };
  const forest = tops.map((el) => convertOutline(el, state));

  const report: OpmlImportReport = {
    nodesPre: state.nodesPre,
    nodesPost: countForest(forest),
    emptyText: state.emptyText,
    notes: state.notes,
    noteLines: state.noteLines,
    noteBlanksDropped: state.noteBlanksDropped,
    textNewlineSplits: state.textNewlineSplits,
    mirrorsLinked: state.mirrorsLinked,
    mirrorsDetached: state.mirrorsDetached,
    degraded: state.degraded.toRecord(),
    degradedTotal: state.degraded.total(),
    anomalies: state.anomalies.toRecord(),
    unknownAttributes: state.unknownAttrs.toRecord(),
  };
  return { forest, report };
}

/**
 * OPML source -> intermediate forest + degradation report. The size guard runs
 * BEFORE parsing; a malformed or truncated document fails into a typed
 * {@link OpmlParseError} carrying the parser's line/column — never a partial
 * forest. Undefined entities (the classic entity bomb) are rejected by the
 * parser itself; DTD entity definitions are never expanded.
 */
export function parseOpml(
  source: string,
  options: { maxLength?: number } = {},
): Effect.Effect<OpmlImportResult, OpmlParseError | OpmlTooLarge> {
  const maxLength = options.maxLength ?? DEFAULT_MAX_OPML_LENGTH;
  if (source.length > maxLength) {
    return Effect.fail(new OpmlTooLarge({ length: source.length, maxLength }));
  }
  return Effect.try({
    try: () => mapDocument(source),
    catch: (error) => {
      if (error instanceof OpmlParseError) return error;
      if (error instanceof XmlError) {
        return new OpmlParseError({
          reason: error.message.split("\n")[0] ?? "XML parse error",
          line: error.line,
          column: error.column,
        });
      }
      return new OpmlParseError({
        reason: error instanceof Error ? error.message : String(error),
        line: null,
        column: null,
      });
    },
  });
}

// --- Forest -> ChangeOp[] plan --------------------------------------------------------

/**
 * Plan the whole forest as ONE atomic batch under `parentId`, anchored after
 * `firstPrev` (the parent's existing anchor sibling, or null for the head).
 *
 * CORRECT BY CONSTRUCTION (the ADR 0028 lesson): sibling wiring comes from the
 * emission order — the forest IS the shape, so nothing reads a tree index and
 * nothing loops `planAddNode` (which would re-read a stale last-sibling and
 * tear the chain). Ids are minted in a first pass so a `_mirror` may reference
 * a source that appears LATER in the document (forward references resolve).
 * The ceiling is a parameter — app 50k, MCP 5k — counted post-split, and a
 * breach fails the WHOLE call: no partial plan, ever.
 */
export function planOpmlImport(
  forest: readonly OpmlImportNode[],
  args: {
    parentId: string | null;
    firstPrev: string | null;
    origin?: string | null;
    timestamp: number;
    newId: () => string;
    maxNodes: number;
  },
):
  | { ops: ChangeOp[]; rootIds: string[]; count: number }
  | OpmlEmpty
  | OpmlImportTooLarge {
  const count = countForest(forest);
  if (count === 0) return new OpmlEmpty();
  if (count > args.maxNodes) {
    return new OpmlImportTooLarge({ count, max: args.maxNodes });
  }

  // Pass 1: mint every node's id, depth-first pre-order, and map the
  // document's `id` attributes to the minted ids (first occurrence wins).
  const minted = new Map<OpmlImportNode, string>();
  const idByOpmlId = new Map<string, string>();
  const mint = (nodes: readonly OpmlImportNode[]): void => {
    for (const node of nodes) {
      const id = args.newId();
      minted.set(node, id);
      if (node.opmlId && !idByOpmlId.has(node.opmlId))
        idByOpmlId.set(node.opmlId, id);
      mint(node.children);
    }
  };
  mint(forest);

  // Pass 2: emit inserts depth-first pre-order — every chunked-frame prefix is
  // chain-valid for live remote viewers (ADR 0037), and each node's
  // prevSiblingId is the previously-emitted sibling AT ITS LEVEL.
  const ops: ChangeOp[] = [];
  const emit = (
    siblings: readonly OpmlImportNode[],
    parentId: string | null,
    initialPrev: string | null,
  ): string[] => {
    const ids: string[] = [];
    let prev = initialPrev;
    for (const node of siblings) {
      const id = minted.get(node)!;
      const mirrorOf = node.mirrorOfOpmlId
        ? (idByOpmlId.get(node.mirrorOfOpmlId) ?? null)
        : null;
      ops.push({
        op: "insert",
        value: makeNode({
          id,
          parentId,
          prevSiblingId: prev,
          text: node.text,
          isTask: node.isTask,
          completed: node.completed,
          kind: node.kind,
          mirrorOf,
          origin: args.origin ?? null,
          createdAt: args.timestamp,
          updatedAt: args.timestamp,
        }),
      });
      ids.push(id);
      // A re-linked mirror has no children of its own (they belong to the
      // source); the mapper already emptied them, this is belt-and-braces for
      // hand-built forests.
      if (mirrorOf === null && node.children.length)
        emit(node.children, id, null);
      prev = id;
    }
    return ids;
  };
  const rootIds = emit(forest, args.parentId, args.firstPrev);
  return { ops, rootIds, count };
}
