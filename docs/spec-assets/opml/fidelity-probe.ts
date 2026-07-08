// OPML importer fidelity probe — throwaway prototype for dotflowy #118.
// NOT app code. Run: bun fidelity-probe.ts <file.opml> [...more]
//
// Parses real Workflowy OPML with @rgrove/parse-xml (the chosen parser, #110),
// dry-runs the locked draft mapping (#113 notes -> child bullets, #114 inline
// rich text -> dotflowy tokens), and reports:
//   1. the attribute/tag inventory actually present (validates the dialect doc),
//   2. a converted {text, completed?, children?} forest,
//   3. a LOSS REPORT: every construct not mapped or degraded, with counts,
//   4. scale numbers (nodes pre/post split, depth, bytes, parse ms).
//
// Token patterns mirror the shipped dotflowy sources byte-for-byte:
//   emphasis  src/data/emphasis.ts   (interior forbids the marker char)
//   code      src/plugins/code/index.ts  `[^`\n]+`
//   highlight src/data/highlight.ts  ==[emoji]?[^=\n]+==  (six colors, bare=blue)
//   link      src/data/links.ts      \[[^\]]*\]\([^)]*\)  + sanitizeLinkLabel/encodeUrlForMarkdown

import { parseXml, XmlElement, XmlText } from "@rgrove/parse-xml";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

class Tally {
  map = new Map<string, number>();
  bump(key: string, n = 1) {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
  }
  get size() {
    return this.map.size;
  }
  entries() {
    return [...this.map.entries()].sort((a, b) => b[1] - a[1]);
  }
}

interface Report {
  file: string;
  bytes: number;
  parseMs: number;
  outlineAttrs: Tally; // attribute-name inventory on <outline>
  unknownAttrs: Tally; // attrs outside text/_note/_complete (+ samples)
  htmlTags: Tally; // inline HTML tag inventory inside text/_note
  timeAttrs: Tally; // attribute names on <time>
  applied: Tally; // mapping rules applied (not loss)
  degraded: Tally; // counted degradations (disclosed, per #114)
  anomalies: Tally; // parser-level oddities (mismatched tags etc.)
  contentLoss: string[]; // VIOLATIONS of "nothing silently lost" (samples)
  accidental: Tally; // plain source text that will tokenize in dotflowy
  samples: { from: string; to: string }[];
  nodesPre: number;
  nodesPost: number;
  depthPre: number;
  depthPost: number;
  emptyText: number;
  notes: number;
  noteLines: number;
  noteBlankDropped: number;
  textNewlineSplits: number;
}

// ---------------------------------------------------------------------------
// HTML mini-parser (the attribute value is HTML *after* the XML decode)
// ---------------------------------------------------------------------------

type HNode =
  | { kind: "text"; value: string }
  | { kind: "el"; tag: string; attrs: Record<string, string>; children: HNode[] };

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
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

const TAG_RE = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseInlineHtml(src: string, anomalies: Tally): HNode[] {
  const root: HNode[] = [];
  const stack: { tag: string; children: HNode[] }[] = [];
  const top = () => (stack.length ? stack[stack.length - 1].children : root);
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
    if (m.index > last)
      top().push({ kind: "text", value: decodeHtmlEntities(src.slice(last, m.index)) });
    last = TAG_RE.lastIndex;
    const [, close, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      const i = stack.map((f) => f.tag).lastIndexOf(tag);
      if (i === -1) {
        anomalies.bump(`stray </${tag}>`);
        continue;
      }
      while (stack.length > i + 1) {
        anomalies.bump(`auto-closed <${stack[stack.length - 1].tag}>`);
        popFrame(stack, top);
      }
      popFrame(stack, top);
    } else {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      for (let a = ATTR_RE.exec(rawAttrs); a; a = ATTR_RE.exec(rawAttrs))
        attrs[a[1]] = decodeHtmlEntities(a[3] ?? a[4] ?? "");
      if (selfClose) top().push({ kind: "el", tag, attrs, children: [] });
      else stack.push({ tag, children: [], attrs } as any);
    }
  }
  if (last < src.length)
    top().push({ kind: "text", value: decodeHtmlEntities(src.slice(last)) });
  while (stack.length) {
    anomalies.bump(`unclosed <${stack[stack.length - 1].tag}>`);
    popFrame(stack, top);
  }
  return root;

  function popFrame(
    st: { tag: string; children: HNode[]; attrs?: Record<string, string> }[],
    parentChildren: () => HNode[],
  ) {
    const frame = st.pop()!;
    parentChildren().push({
      kind: "el",
      tag: frame.tag,
      attrs: (frame as any).attrs ?? {},
      children: frame.children,
    });
  }
}

function flattenText(nodes: HNode[]): string {
  return nodes
    .map((n) => (n.kind === "text" ? n.value : flattenText(n.children)))
    .join("");
}

function censusTags(nodes: HNode[], tally: Tally) {
  for (const n of nodes) {
    if (n.kind === "el") {
      tally.bump(n.tag);
      censusTags(n.children, tally);
    }
  }
}

function containsTag(nodes: HNode[], tag: string): boolean {
  return nodes.some(
    (n) => n.kind === "el" && (n.tag === tag || containsTag(n.children, tag)),
  );
}

// ---------------------------------------------------------------------------
// The draft mapping (#114): HTML tree -> dotflowy token string
// ---------------------------------------------------------------------------

// marker char forbidden in the interior, per the shipped token patterns
const FORMAT_MARKERS: Record<string, { open: string; close: string; forbid: RegExp }> = {
  b: { open: "**", close: "**", forbid: /[*\n]/ },
  i: { open: "*", close: "*", forbid: /[*\n]/ },
  u: { open: "~", close: "~", forbid: /[~\n]/ },
  s: { open: "~~", close: "~~", forbid: /[~\n]/ },
  code: { open: "`", close: "`", forbid: /[`\n]/ },
};

// #114 color table -> shipped ADR 0035 emoji palette (red/orange/yellow/green/blue/purple).
// NOTE: #114 lists gray/brown -> WHITE (⚪), but the shipped palette has no white —
// the probe maps those to bare `==` (default blue) and counts the divergence.
const MARK_COLOR: Record<string, string> = {
  red: "🔴",
  orange: "🟠",
  yellow: "🟡",
  green: "🟢",
  teal: "🟢",
  sky: "🔵",
  blue: "🔵",
  purple: "🟣",
  pink: "🟣",
};

function sanitizeLinkLabel(title: string): string {
  return title.replace(/]/g, "").replace(/\s+/g, " ").trim();
}
function encodeUrlForMarkdown(url: string): string {
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

interface ConvertCtx {
  r: Report;
  insideFormat: boolean; // already inside a formatting tag (FLAT rule)
}

function convert(nodes: HNode[], ctx: ConvertCtx): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") {
      out += n.value;
      continue;
    }
    out += convertEl(n, ctx);
  }
  return out;
}

function convertEl(el: Extract<HNode, { kind: "el" }>, ctx: ConvertCtx): string {
  const { r } = ctx;
  switch (el.tag) {
    case "a": {
      const rawLabel = flattenText(el.children);
      // formatting INSIDE the link is dropped (link wins; label is plain)
      const innerTags = new Tally();
      censusTags(el.children, innerTags);
      for (const [t, c] of innerTags.entries())
        r.degraded.bump(`styling inside <a> dropped (<${t}>)`, c);
      const url = encodeUrlForMarkdown(el.attrs["href"] ?? "");
      const label = sanitizeLinkLabel(rawLabel);
      if (label !== rawLabel.trim() || /]/.test(rawLabel))
        r.degraded.bump("link label sanitized (`]` stripped / whitespace collapsed)");
      if (url !== (el.attrs["href"] ?? "")) r.applied.bump("link url percent-encoded");
      r.applied.bump("<a> -> [label](url)");
      return `[${label}](${url})`;
    }
    case "time": {
      // ADOPTED (#114/#120): keyed on canonical attrs; probe validates the attrs
      // and emits the display text (the documented fallback rendering).
      const y = el.attrs["startYear"], mo = el.attrs["startMonth"], d = el.attrs["startDay"];
      if (y && mo && d) r.applied.bump("<time> -> date token (canonical attrs OK)");
      else {
        r.degraded.bump("<time> missing canonical start attrs -> display text kept");
      }
      if (el.attrs["startHour"]) r.applied.bump("<time> carries startHour");
      for (const k of Object.keys(el.attrs))
        if (k.startsWith("end")) r.applied.bump(`<time> carries ${k}`);
      return flattenText(el.children);
    }
    case "mention": {
      const id = el.attrs["id"] ?? "?";
      r.degraded.bump("<mention> -> @mention(id) (name unrecoverable)");
      return `@mention(${id})`;
    }
    case "b":
    case "i":
    case "u":
    case "s":
    case "code": {
      const spec = FORMAT_MARKERS[el.tag];
      // link anywhere inside wins outright — emit only the inner conversion
      if (containsTag(el.children, "a")) {
        r.degraded.bump(`<${el.tag}> dropped: contains a link (link wins)`);
        return convert(el.children, ctx);
      }
      if (ctx.insideFormat) {
        r.degraded.bump(`nested <${el.tag}> dropped (outermost wins)`);
        return convert(el.children, ctx);
      }
      const interior = convert(el.children, { ...ctx, insideFormat: true });
      if (interior.length === 0) {
        r.degraded.bump(`empty <${el.tag}> dropped`);
        return "";
      }
      if (spec.forbid.test(interior)) {
        r.degraded.bump(`<${el.tag}> dropped: marker char in interior`);
        return interior;
      }
      r.applied.bump(`<${el.tag}> -> ${spec.open}x${spec.close}`);
      return spec.open + interior + spec.close;
    }
    case "mark": {
      if (containsTag(el.children, "a")) {
        r.degraded.bump("<mark> dropped: contains a link (link wins)");
        return convert(el.children, ctx);
      }
      if (ctx.insideFormat) {
        r.degraded.bump("nested <mark> dropped (outermost wins)");
        return convert(el.children, ctx);
      }
      const interior = convert(el.children, { ...ctx, insideFormat: true });
      if (interior.length === 0) {
        r.degraded.bump("empty <mark> dropped");
        return "";
      }
      if (/[=\n]/.test(interior)) {
        r.degraded.bump("<mark> dropped: `=` or newline in interior");
        return interior;
      }
      const cls = el.attrs["class"] ?? "";
      const colorName = /(?:^|\s)(?:c|bc)-([a-z]+)/.exec(cls)?.[1];
      const emoji = colorName ? MARK_COLOR[colorName] : undefined;
      if (colorName && !emoji) {
        if (colorName === "gray" || colorName === "brown")
          r.degraded.bump(
            `<mark ${colorName}> -> bare == (spec says ⚪ but shipped palette has no white)`,
          );
        else r.degraded.bump(`<mark ${colorName}> unrecognized -> bare ==`);
      }
      r.applied.bump("<mark> -> ==highlight==");
      return `==${emoji ?? ""}${interior}==`;
    }
    default: {
      r.degraded.bump(`unknown <${el.tag}> stripped, text kept`);
      return convert(el.children, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Accidental tokenization: plain source text that dotflowy will render as tokens
// ---------------------------------------------------------------------------

const BOLD = "\\*\\*[^*\\n]+\\*\\*";
const ITALIC = "\\*[^*\\n]+\\*";
const STRIKE = "~~[^~\\n]+~~";
const UNDER = "~[^~\\n]+~";
const CODE = "`[^`\\n]+`";
const HI = "==[^=\\n]+==";
const LINK = "\\[[^\\]]*\\]\\([^)]*\\)";
const UNDERSCORE_I = "(?<![\\p{L}\\p{N}])_[^_\\n]+_(?![\\p{L}\\p{N}])";

function countAccidental(plainSegments: string[], tally: Tally) {
  const checks: [string, RegExp][] = [
    ["bold **x**", new RegExp(BOLD, "u")],
    ["strike ~~x~~", new RegExp(STRIKE, "u")],
    ["italic *x*", new RegExp(ITALIC, "u")],
    ["underline ~x~", new RegExp(UNDER, "u")],
    ["underscore italic _x_", new RegExp(UNDERSCORE_I, "u")],
    ["code `x`", new RegExp(CODE, "u")],
    ["highlight ==x==", new RegExp(HI, "u")],
    ["link [l](u)", new RegExp(LINK, "u")],
  ];
  for (const seg of plainSegments) {
    for (const [name, re] of checks) {
      // strike wins over underline, bold over italic in the combined regex; a
      // plain count per pattern is good enough for a probe
      if (re.test(seg)) tally.bump(`plain text will tokenize as ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Outline walk + conversion to the dotflowy forest
// ---------------------------------------------------------------------------

interface OutNode {
  text: string;
  completed?: boolean;
  isTask?: boolean;
  children?: OutNode[];
}

const KNOWN_ATTRS = new Set(["text", "_note", "_complete"]);

function convertValue(raw: string, r: Report): { text: string; extraLines: string[] } {
  // raw is the XML-decoded attribute value: an HTML string, possibly multi-line
  const tree = parseInlineHtml(raw, r.anomalies);
  censusTags(tree, r.htmlTags);
  // census <time> attr names
  (function walkTime(nodes: HNode[]) {
    for (const n of nodes)
      if (n.kind === "el") {
        if (n.tag === "time") for (const k of Object.keys(n.attrs)) r.timeAttrs.bump(k);
        walkTime(n.children);
      }
  })(tree);

  const converted = convert(tree, { r, insideFormat: false });

  // content-survival check: every text leaf (post entity-decode) must appear in
  // the converted output, except the two transforms that legitimately rewrite
  // text (mention's single-space interior; sanitized link labels).
  (function checkLoss(nodes: HNode[], insideMention: boolean, insideLink: boolean) {
    for (const n of nodes) {
      if (n.kind === "text") {
        if (insideMention) continue; // interior is a space; replaced by @mention(id)
        const needle = insideLink ? sanitizeLinkLabel(n.value) : n.value;
        // per-line: converted output is later split on \n
        for (const part of needle.split("\n"))
          if (part && !converted.includes(part))
            r.contentLoss.push(JSON.stringify(part).slice(0, 80));
      } else
        checkLoss(
          n.children,
          insideMention || n.tag === "mention",
          insideLink || n.tag === "a",
        );
    }
  })(tree, false, false);

  // accidental tokenization only applies to PLAIN source text (rule 2, #114)
  const plainSegs: string[] = [];
  (function collectPlain(nodes: HNode[]) {
    for (const n of nodes)
      if (n.kind === "text") plainSegs.push(n.value);
      else if (n.tag !== "code") collectPlain(n.children);
  })(tree);
  countAccidental(plainSegs, r.accidental);

  const lines = converted.split("\n");
  return { text: lines[0] ?? "", extraLines: lines.slice(1) };
}

function convertOutline(el: XmlElement, r: Report, depth: number): OutNode {
  r.nodesPre++;
  r.depthPre = Math.max(r.depthPre, depth);
  for (const name of Object.keys(el.attributes)) {
    r.outlineAttrs.bump(name);
    if (!KNOWN_ATTRS.has(name)) r.unknownAttrs.bump(`${name}="${el.attributes[name]}"`.slice(0, 60));
  }

  const rawText = el.attributes["text"] ?? "";
  if (rawText === "") r.emptyText++;
  const { text, extraLines } = convertValue(rawText, r);

  const prepend: OutNode[] = [];
  // &#10; continuation lines in `text` -> child bullets BEFORE note lines (#114)
  const contLines = extraLines.filter((l) => l.trim() !== "");
  if (extraLines.length) {
    r.textNewlineSplits++;
    r.applied.bump("newline in text -> continuation child bullets", contLines.length);
    for (const l of contLines) prepend.push({ text: l });
  }
  // _note -> prepended child bullets, one per non-blank line (#113)
  const noteRaw = el.attributes["_note"];
  if (noteRaw !== undefined) {
    r.notes++;
    const { text: first, extraLines: rest } = convertValue(noteRaw, r);
    const noteLines = [first, ...rest];
    for (const l of noteLines) {
      if (l.trim() === "") r.noteBlankDropped++;
      else {
        prepend.push({ text: l });
        r.noteLines++;
      }
    }
  }

  const realChildren = el.children
    .filter((c): c is XmlElement => c instanceof XmlElement && c.name === "outline")
    .map((c) => convertOutline(c, r, depth + 1));

  const node: OutNode = { text };
  if (el.attributes["_complete"] === "true") node.completed = true;
  if (el.attributes["_task"] === "true") {
    node.isTask = true;
    r.applied.bump('_task="true" -> isTask');
  }
  const children = [...prepend, ...realChildren];
  if (children.length) node.children = children;
  return node;
}

function countPost(nodes: OutNode[], depth: number, r: Report): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    r.depthPost = Math.max(r.depthPost, depth);
    if (node.children) n += countPost(node.children, depth + 1, r);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function probe(file: string): { r: Report; forest: OutNode[] } {
  const bytesBuf = require("fs").readFileSync(file);
  const src = bytesBuf.toString("utf8");
  const r: Report = {
    file,
    bytes: bytesBuf.length,
    parseMs: 0,
    outlineAttrs: new Tally(),
    unknownAttrs: new Tally(),
    htmlTags: new Tally(),
    timeAttrs: new Tally(),
    applied: new Tally(),
    degraded: new Tally(),
    anomalies: new Tally(),
    contentLoss: [],
    accidental: new Tally(),
    samples: [],
    nodesPre: 0,
    nodesPost: 0,
    depthPre: 0,
    depthPost: 0,
    emptyText: 0,
    notes: 0,
    noteLines: 0,
    noteBlankDropped: 0,
    textNewlineSplits: 0,
  };
  const t0 = performance.now();
  const doc = parseXml(src);
  r.parseMs = Math.round(performance.now() - t0);

  const opml = doc.children.find(
    (c): c is XmlElement => c instanceof XmlElement && c.name === "opml",
  )!;
  const body = opml.children.find(
    (c): c is XmlElement => c instanceof XmlElement && c.name === "body",
  )!;
  const tops = body.children.filter(
    (c): c is XmlElement => c instanceof XmlElement && c.name === "outline",
  );

  const forest = tops.map((el) => convertOutline(el, r, 1));
  r.nodesPost = countPost(forest, 1, r);

  // samples: original attr value -> converted line(s), for rich nodes
  const want = 18;
  (function sample(el: XmlElement) {
    if (r.samples.length >= want) return;
    const t = el.attributes["text"] ?? "";
    if (/[<&]/.test(t) || el.attributes["_note"] !== undefined) {
      const sub = new Tally();
      const dummy: Report = { ...r, anomalies: sub, applied: new Tally(), degraded: new Tally(), htmlTags: new Tally(), timeAttrs: new Tally(), accidental: new Tally(), contentLoss: [] } as Report;
      const conv = convertValue(t, dummy);
      const note = el.attributes["_note"];
      const noteConv = note !== undefined ? convertValue(note, dummy) : null;
      r.samples.push({
        from: t + (note !== undefined ? `  ⟨note⟩ ${note}` : ""),
        to:
          [conv.text, ...conv.extraLines].join(" ⏎ ") +
          (noteConv ? `  ⟨note-bullets⟩ ${[noteConv.text, ...noteConv.extraLines].filter((l) => l.trim()).join(" ⏎ ")}` : ""),
      });
    }
    for (const c of el.children)
      if (c instanceof XmlElement && c.name === "outline") sample(c);
  })(tops[0] ?? ({ children: [], attributes: {} } as any));
  // walk remaining tops if the first didn't fill the quota
  for (const t of tops.slice(1)) {
    if (r.samples.length >= want) break;
    (function sample2(el: XmlElement) {
      if (r.samples.length >= want) return;
      const t2 = el.attributes["text"] ?? "";
      if (/[<&]/.test(t2)) {
        const dummy: Report = { ...r, anomalies: new Tally(), applied: new Tally(), degraded: new Tally(), htmlTags: new Tally(), timeAttrs: new Tally(), accidental: new Tally(), contentLoss: [] } as Report;
        const conv = convertValue(t2, dummy);
        r.samples.push({ from: t2, to: [conv.text, ...conv.extraLines].join(" ⏎ ") });
      }
      for (const c of el.children)
        if (c instanceof XmlElement && c.name === "outline") sample2(c);
    })(t);
  }

  return { r, forest };
}

function fmtTally(t: Tally, indent = ""): string {
  if (t.size === 0) return `${indent}(none)\n`;
  return t.entries().map(([k, v]) => `${indent}${String(v).padStart(7)}  ${k}`).join("\n") + "\n";
}

function reportMd(r: Report): string {
  let s = "";
  s += `## ${r.file.split("/").pop()}\n\n`;
  s += `- **bytes:** ${r.bytes.toLocaleString()} — **parse:** ${r.parseMs} ms\n`;
  s += `- **nodes:** ${r.nodesPre.toLocaleString()} pre-split → **${r.nodesPost.toLocaleString()} post-split** (${r.notes} notes → ${r.noteLines} note bullets, ${r.noteBlankDropped} blank lines dropped; ${r.textNewlineSplits} text-newline splits)\n`;
  s += `- **depth:** ${r.depthPre} pre → ${r.depthPost} post — **empty-text bullets:** ${r.emptyText}\n\n`;
  s += `### <outline> attribute inventory\n\n\`\`\`\n${fmtTally(r.outlineAttrs)}\`\`\`\n\n`;
  s += `### Unknown attributes (loss-report candidates)\n\n\`\`\`\n${fmtTally(r.unknownAttrs)}\`\`\`\n\n`;
  s += `### Inline HTML tag inventory (text + _note)\n\n\`\`\`\n${fmtTally(r.htmlTags)}\`\`\`\n\n`;
  s += `### <time> attribute census\n\n\`\`\`\n${fmtTally(r.timeAttrs)}\`\`\`\n\n`;
  s += `### Mapping rules applied\n\n\`\`\`\n${fmtTally(r.applied)}\`\`\`\n\n`;
  s += `### Degradations (counted + disclosed, per #114)\n\n\`\`\`\n${fmtTally(r.degraded)}\`\`\`\n\n`;
  s += `### HTML anomalies\n\n\`\`\`\n${fmtTally(r.anomalies)}\`\`\`\n\n`;
  s += `### Accidental tokenization (plain text that will render as dotflowy tokens)\n\n\`\`\`\n${fmtTally(r.accidental)}\`\`\`\n\n`;
  s += `### CONTENT LOSS (must be empty — "nothing silently lost")\n\n`;
  s +=
    r.contentLoss.length === 0
      ? `**none** ✅\n\n`
      : `**${r.contentLoss.length} violations** ❌\n\n\`\`\`\n${r.contentLoss.slice(0, 25).join("\n")}\n\`\`\`\n\n`;
  if (r.samples.length) {
    s += `### Sample conversions\n\n`;
    for (const { from, to } of r.samples)
      s += `- \`${from.replace(/`/g, "ˋ").slice(0, 220)}\`\n  → \`${to.replace(/`/g, "ˋ").slice(0, 220)}\`\n`;
    s += "\n";
  }
  return s;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun fidelity-probe.ts <file.opml> [...more]");
  process.exit(1);
}
let out = `# OPML importer fidelity probe — report\n\nGenerated by \`fidelity-probe.ts\` (throwaway, #118). Mapping: #113 (notes) + #114 (inline rich text) as locked on the map.\n\n`;
for (const f of files) {
  const { r } = probe(f);
  out += reportMd(r);
}
console.log(out);
