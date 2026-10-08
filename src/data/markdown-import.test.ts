import { describe, expect, test } from "bun:test";

import { outlineToMarkdown } from "./markdown";
import {
  countForest,
  parseMarkdownForest,
  planMarkdownPaste,
  type MdNode,
  type MdPastePlan,
} from "./markdown-import";
import { buildTreeIndex, createNode, type Node, type NodeKind } from "./tree";

// --- helpers ------------------------------------------------------------------

/** The outline the round-trip compares: `outlineToMarkdown` carries text, task
 *  state, kind, and structure -- nothing else. */
interface OutlineFixture {
  text: string;
  isTask: boolean;
  completed: boolean;
  kind: NodeKind;
  children: OutlineFixture[];
}

const outlineFixture = (
  text: string,
  children: OutlineFixture[] = [],
  isTask = false,
  completed = false,
  kind: NodeKind = null,
): OutlineFixture => ({ text, isTask, completed, kind, children });

/** A paragraph node, the reason this file grew a `kind` column (ADR 0045). */
const para = (text: string, children: OutlineFixture[] = []): OutlineFixture =>
  outlineFixture(text, children, false, false, "paragraph");

const forestFixture = (forest: readonly MdNode[]): OutlineFixture[] =>
  forest.map((n) => ({
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    kind: n.kind,
    children: forestFixture(n.children),
  }));

/** Materialize a `OutlineFixture` forest into a `TreeIndex`, wiring the sibling chain.
 *  `mirrors` maps a node's index-path label to the id it mirrors. */
function buildIndex(
  forest: OutlineFixture[],
  mirrorOf: Record<string, string> = {},
) {
  const nodes: Node[] = [];
  let n = 0;
  const walk = (siblings: OutlineFixture[], parentId: string | null): void => {
    let prev: string | null = null;
    for (const node of siblings) {
      const id = `n${n++}`;
      nodes.push(
        createNode({
          id,
          parentId,
          prevSiblingId: prev,
          text: node.text,
          isTask: node.isTask,
          completed: node.completed,
          kind: node.kind,
          mirrorOf: mirrorOf[id] ?? null,
        }),
      );
      walk(node.children, id);
      prev = id;
    }
  };
  walk(forest, null);
  return { index: buildTreeIndex(nodes), ids: nodes.map((x) => x.id) };
}

/** Round-trip one forest through export + parse. */
function roundTrip(
  forest: OutlineFixture[],
  mirrorOf: Record<string, string> = {},
): OutlineFixture[] {
  const { index } = buildIndex(forest, mirrorOf);
  const roots = index.childrenByParent.get("__root__") ?? [];
  const md = outlineToMarkdown(index, roots);
  return forestFixture(parseMarkdownForest(md));
}

/** A tiny deterministic PRNG -- the property test must fail reproducibly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Text the round-trip is expected to preserve byte-for-byte. It deliberately
// includes every leading construct the parser must NOT strip twice, plus the
// inline tokens that are already markdown (`node.text` IS markdown).
const TEXTS = [
  "",
  "plain",
  "-",
  "- foo", // exports as `- - foo`; exactly one marker is stripped
  "* star",
  "+ plus",
  "1. ordinal",
  "2) paren",
  "# heading-looking", // exports as `- # heading-looking`; not a heading there
  "#urgent", // a tag, not a heading -- the space is what separates them
  "> quoted", // exports as `- > quoted`; the `>` is no longer at content start
  "```ts", // a fence delimiter, defused by the `- ` that precedes it on export
  "```",
  "**bold** and *it*",
  "`code`",
  "[label](https://example.com)",
  "==highlight==",
  "||spoiler||",
  "[[2026-07-09]]",
  "trailing space ",
  "a  b", // interior runs survive
  "    if x:", // a fence interior's indent; the marker eats exactly one space
  "\tif x:",
];

// The subset of TEXTS a PARAGRAPH may carry and still export as a bare line
// (ADR 0045). Everything else in TEXTS is a lookalike -- empty, indented, a
// fence, or something the block grammar would eat -- and degrades to a bullet.
const PARAGRAPH_SAFE_TEXTS = [
  "plain",
  "#urgent",
  "**bold** and *it*",
  "`code`",
  "[label](https://example.com)",
  "==highlight==",
  "||spoiler||",
  "[[2026-07-09]]",
  "trailing space ",
  "a  b",
];

function randomForest(next: () => number, depth = 0): OutlineFixture[] {
  const count = Math.floor(next() * (depth === 0 ? 5 : 3));
  const out: OutlineFixture[] = [];
  for (let i = 0; i < count; i++) {
    // Kinds are mutually exclusive, so one roll picks all three buckets:
    // task < 0.25 <= paragraph < 0.55 <= plain bullet.
    const roll = next();
    const isTask = roll < 0.25;
    out.push({
      text: TEXTS[Math.floor(next() * TEXTS.length)]!,
      isTask,
      completed: isTask && next() < 0.5,
      kind: !isTask && roll < 0.55 ? "paragraph" : null,
      children: depth < 3 ? randomForest(next, depth + 1) : [],
    });
  }
  return out;
}

/** A forest of paragraphs whose text is guaranteed to survive as a bare line. */
function safeParagraphForest(next: () => number, depth = 0): OutlineFixture[] {
  const count = Math.floor(next() * (depth === 0 ? 5 : 3));
  const out: OutlineFixture[] = [];
  for (let i = 0; i < count; i++) {
    const text =
      PARAGRAPH_SAFE_TEXTS[Math.floor(next() * PARAGRAPH_SAFE_TEXTS.length)]!;
    out.push(para(text, depth < 3 ? safeParagraphForest(next, depth + 1) : []));
  }
  return out;
}

/** Everything the round-trip must preserve UNCONDITIONALLY: text, task state,
 *  done state, structure. Kind is the one field allowed to degrade. */
const contentOnly = (forest: readonly OutlineFixture[]): unknown[] =>
  forest.map((n) => ({
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    children: contentOnly(n.children),
  }));

// --- the invariant ------------------------------------------------------------

describe("parse(outlineToMarkdown(t)) === t", () => {
  test("content and structure hold over generated trees", () => {
    const next = rng(0xd07f10);
    for (let i = 0; i < 300; i++) {
      const forest = randomForest(next);
      if (forest.length === 0) continue;
      expect(contentOnly(roundTrip(forest))).toEqual(contentOnly(forest));
    }
  });

  test("kind holds for paragraphs whose text survives as a bare line", () => {
    const next = rng(0x9a12c3);
    for (let i = 0; i < 300; i++) {
      const forest = safeParagraphForest(next);
      if (forest.length === 0) continue;
      expect(roundTrip(forest)).toEqual(forest);
    }
  });

  test("a degraded paragraph is a FIXED POINT, never a slide", () => {
    // The exporter's guard buys idempotence, not perfection: a lookalike
    // paragraph degrades to a bullet ONCE, and every copy after that is stable.
    const next = rng(0x5eed42);
    for (let i = 0; i < 300; i++) {
      const forest = randomForest(next);
      if (forest.length === 0) continue;
      const once = roundTrip(forest);
      expect(roundTrip(once)).toEqual(once);
    }
  });

  test.each<[string, OutlineFixture[], OutlineFixture[]]>([
    // `- ` alone is eaten by editors; the empty bullet must still come back.
    ["a single empty bullet", [outlineFixture("")], [outlineFixture("")]],
    [
      "an open task with no text",
      [outlineFixture("", [], true, false)],
      [outlineFixture("", [], true, false)],
    ],
    [
      "a done task with no text",
      [outlineFixture("", [], true, true)],
      [outlineFixture("", [], true, true)],
    ],
    // Exception 2: literal `[ ] x` text re-imports as a task.
    [
      "`[ ] x` as literal text",
      [outlineFixture("[ ] buy milk")],
      [outlineFixture("buy milk", [], true, false)],
    ],
    // The marker eats exactly one space. Consuming `\s+` would drop the
    // indentation of every fence interior the fence rule promises to keep
    // (ADR 0044).
    ["two leading spaces", [outlineFixture("  x")], [outlineFixture("  x")]],
    ["a leading tab", [outlineFixture("\tx")], [outlineFixture("\tx")]],
    [
      "an indented task",
      [outlineFixture("    if x:", [], true, false)],
      [outlineFixture("    if x:", [], true, false)],
    ],
    // A lookalike paragraph falls back to `- `: text intact, kind degraded.
    ["paragraph `- foo`", [para("- foo")], [outlineFixture("- foo")]],
    ["paragraph `# foo`", [para("# foo")], [outlineFixture("# foo")]],
    ["paragraph `> quoted`", [para("> quoted")], [outlineFixture("> quoted")]],
    ["paragraph ```", [para("```")], [outlineFixture("```")]],
    ["paragraph `-`", [para("-")], [outlineFixture("-")]],
    ["paragraph `1. x`", [para("1. x")], [outlineFixture("1. x")]],
    // A blank line is a separator, so an empty paragraph degrades too.
    ["an empty paragraph", [para("")], [outlineFixture("")]],
    // trimStart would eat the indent of a bare line.
    ["an indented paragraph", [para("  x")], [outlineFixture("  x")]],
    [
      "a tab-indented paragraph",
      [para("\tif x:")],
      [outlineFixture("\tif x:")],
    ],
    [
      "a paragraph under a task parent stays a paragraph",
      [outlineFixture("job", [para("why it matters")], true, false)],
      [outlineFixture("job", [para("why it matters")], true, false)],
    ],
  ])("round-trips %s", (_name, forest, expected) => {
    expect(roundTrip(forest)).toEqual(expected);
  });

  // Exception 3: a mirror flattens to an independent copy on export.
  test.each<
    [string, OutlineFixture[], Record<string, string>, string[], string[]]
  >([
    [
      "a mirror expands to a copy of its source",
      [outlineFixture("source", [outlineFixture("kid")]), outlineFixture("")],
      { n2: "n0" },
      ["n0", "n2"],
      ["- source", "  - kid", "- source", "  - kid"],
    ],
    [
      "a mirror inside its own source emits once and stops",
      [outlineFixture("source", [outlineFixture("snapshot")])],
      { n1: "n0" },
      ["n0"],
      ["- source", "  - source"],
    ],
    [
      "one source mirrored into two branches expands in both",
      [
        outlineFixture("src", [outlineFixture("kid")]),
        outlineFixture("a", [outlineFixture("")]),
        outlineFixture("b", [outlineFixture("")]),
      ],
      { n3: "n0", n5: "n0" },
      ["n2", "n4"],
      ["- a", "  - src", "    - kid", "- b", "  - src", "    - kid"],
    ],
  ])("exception 3: %s", (_name, forest, mirrorOf, roots, lines) => {
    const { index } = buildIndex(forest, mirrorOf);
    expect(outlineToMarkdown(index, roots)).toBe(lines.join("\n"));
  });

  test("a paragraph exports as a bare line, at every depth", () => {
    const forest = [para("prose", [para("nested"), outlineFixture("kid")])];
    const { index } = buildIndex(forest);
    expect(outlineToMarkdown(index, ["n0"])).toBe(
      ["prose", "  nested", "  - kid"].join("\n"),
    );
    expect(roundTrip(forest)).toEqual(forest);
  });

  test("a pasted code fence survives being copied back out", () => {
    // The end-to-end outlineFixture of the bug above: paste Python, copy as markdown,
    // paste it back. Every level of indentation must still be there.
    const src = [
      "```py",
      "def f():",
      "    if x:",
      "        return 1",
      "```",
    ].join("\n");
    const once = forestFixture(parseMarkdownForest(src));
    expect(once.map((n) => n.text)).toEqual([
      "```py",
      "def f():",
      "    if x:",
      "        return 1",
      "```",
    ]);
    expect(roundTrip(once)).toEqual(once);
  });
});

// --- the grammar --------------------------------------------------------------

test.each<[string, string, string[]]>([
  [
    "one line, one bullet -- no paragraph continuation",
    "alpha\nbravo\ncharlie",
    ["alpha", "bravo", "charlie"],
  ],
  ["blank lines are separators", "a\n\n\nb", ["a", "b"]],
  [
    "a trailing newline is a terminator, not an empty bullet",
    "a\nb\n",
    ["a", "b"],
  ],
  ["strips exactly one list marker (`- - `)", "- - foo", ["- foo"]],
  ["strips exactly one list marker (`- # `)", "- # foo", ["# foo"]],
  [
    "every list marker shape strips",
    "1. one\n2) two\n* star\n+ plus",
    ["one", "two", "star", "plus"],
  ],
  ["a dash marker", "- item", ["item"]],
  ["a tab after the marker", "-\titem", ["item"]],
  // The deliberate divergence from lenient readers: `outlineToMarkdown` emits
  // one space, so foreign padding survives as leading whitespace.
  ["padding after the marker is content", "-   item", ["  item"]],
  ["padding after a task marker is content", "- [ ]   item", ["  item"]],
  [
    "a bare marker is an empty node, never a dropped line",
    "- a\n-\n- \n*",
    ["a", "", "", ""],
  ],
  [
    "`*bold*` is not a bullet (a marker needs trailing space or EOL)",
    "*bold* text",
    ["*bold* text"],
  ],
  ["`#urgent` stays a tag (heading needs the space)", "#urgent", ["#urgent"]],
  ["seven hashes is not a heading", "####### seven", ["####### seven"]],
  ["`# urgent` is a heading", "# urgent", ["urgent"]],
  ["`[]` with nothing inside is text, not a checkbox", "- [] x", ["[] x"]],
  [
    "blockquote markers strip; the text survives whole",
    "> quoted\n>> deeper\n> - listed",
    ["quoted", "deeper", "listed"],
  ],
  // What `outlineToMarkdown` emits for fence-delimiter bullets.
  [
    "a re-pasted fence delimiter never re-fires",
    "- ```ts\n- const x = 1\n- ```",
    ["```ts", "const x = 1", "```"],
  ],
])("parseMarkdownForest texts: %s", (_name, md, expected) => {
  expect(parseMarkdownForest(md).map((n) => n.text)).toEqual(expected);
});

const nested = [
  outlineFixture("a", [outlineFixture("b", [outlineFixture("c")])]),
];

test.each<[string, string, OutlineFixture[]]>([
  [
    "headings drive nesting; the shallowest normalizes to depth 0",
    "### Section\nbody\n#### Sub\nmore",
    [
      outlineFixture("Section", [
        para("body"),
        outlineFixture("Sub", [para("more")]),
      ]),
    ],
  ],
  [
    "a skipped heading level clamps instead of jumping",
    "# A\n##### E\ntext",
    [outlineFixture("A", [outlineFixture("E", [para("text")])])],
  ],
  [
    "a heading pops back out to its own level",
    "# A\n## B\n# C",
    [outlineFixture("A", [outlineFixture("B")]), outlineFixture("C")],
  ],
  [
    "list indentation nests inside the heading floor",
    "# A\n- one\n  - two",
    [outlineFixture("A", [outlineFixture("one", [outlineFixture("two")])])],
  ],
  ["2-space indents nest", "- a\n  - b\n    - c", nested],
  ["4-space indents nest", "- a\n    - b\n        - c", nested],
  ["tab indents nest", "- a\n\t- b\n\t\t- c", nested],
  [
    "a skipped indent level clamps to one level down",
    "- a\n        - b",
    [outlineFixture("a", [outlineFixture("b")])],
  ],
  [
    "task markers map to isTask/completed",
    "- [ ] open\n- [x] done\n- [X] DONE",
    [
      outlineFixture("open", [], true, false),
      outlineFixture("done", [], true, true),
      outlineFixture("DONE", [], true, true),
    ],
  ],
  [
    "a task marker needs its list marker (GFM), so bare `[ ] x` is text",
    "[ ] x\ny",
    [para("[ ] x"), para("y")],
  ],
  [
    // ADR 0044 rule 2: the heading grammar fires only at content start, before
    // any marker. `>` is a marker, so `# A` stays literal text (ADR 0045).
    "a quoted heading is not a heading",
    "> # A\n> body",
    [para("# A"), para("body")],
  ],
  [
    // Raw mode infers no kind, so only the line AFTER the fence is a paragraph.
    "fences suppress the grammar and keep their delimiters and blank lines",
    "```ts\n- not a bullet\n  indented\n\n```\nafter",
    [
      outlineFixture("```ts"),
      outlineFixture("- not a bullet"),
      outlineFixture("  indented"),
      outlineFixture(""),
      outlineFixture("```"),
      para("after"),
    ],
  ],
  [
    "a fence closes only on a bare delimiter of the same char",
    "```\n~~~\n```js\n```\nout",
    [
      outlineFixture("```"),
      outlineFixture("~~~"),
      outlineFixture("```js"),
      outlineFixture("```"),
      para("out"),
    ],
  ],
])("parseMarkdownForest structure: %s", (_name, md, expected) => {
  expect(forestFixture(parseMarkdownForest(md))).toEqual(expected);
});

test("literal mode: every line is one verbatim top-level bullet", () => {
  const forest = parseMarkdownForest("- a\n  - b\n# C\n```\n+ d", {
    literal: true,
  });
  expect(forestFixture(forest)).toEqual([
    outlineFixture("- a"),
    outlineFixture("  - b"),
    outlineFixture("# C"),
    outlineFixture("```"),
    outlineFixture("+ d"),
  ]);
});

test("countForest counts the whole forest", () => {
  expect(countForest(parseMarkdownForest("- a\n  - b\n    - c\n- d"))).toBe(4);
});

// --- the landing --------------------------------------------------------------

type PlannedAnchor = MdPastePlan["anchor"];

describe("planMarkdownPaste", () => {
  // anchor "A" with an existing child "kid" and a following sibling "next".
  const fixture = () => {
    const a = createNode({ id: "A", text: "anchor" });
    const next = createNode({ id: "next", prevSiblingId: "A", text: "next" });
    const kid = createNode({ id: "kid", parentId: "A", text: "kid" });
    return buildTreeIndex([a, next, kid]);
  };

  let n = 0;
  const plan = (
    md: string,
    head = "",
    tail = "",
    placement: "sibling" | "child-prepend" = "sibling",
  ) => {
    n = 0;
    return planMarkdownPaste({
      index: fixture(),
      anchorId: "A",
      placement,
      forest: parseMarkdownForest(md),
      head,
      tail,
      newId: () => `p${n++}`,
    });
  };

  test("the anchor absorbs the first line; its children prepend", () => {
    const p = plan("one\n  two\nthree")!;
    expect(p.anchor.text).toBe("one");
    expect(p.inserts).toEqual([
      {
        id: "p0",
        parentId: "A",
        prevSiblingId: null,
        text: "two",
        isTask: false,
        completed: false,
        kind: "paragraph",
      },
      {
        id: "p1",
        parentId: null,
        prevSiblingId: "A",
        text: "three",
        isTask: false,
        completed: false,
        kind: "paragraph",
      },
    ]);
    // The anchor's existing child follows the pasted one; the anchor's existing
    // sibling follows the pasted root.
    expect(p.repoints).toEqual([
      { id: "kid", prevSiblingId: "p0" },
      { id: "next", prevSiblingId: "p1" },
    ]);
  });

  test("head is preserved; tail welds onto the last inserted node, however deep", () => {
    const p = plan("one\n  two", "HEAD ", " TAIL")!;
    expect(p.anchor.text).toBe("HEAD one");
    expect(p.inserts[0]!.text).toBe("two TAIL");
    expect(p.focusId).toBe("p0");
    expect(p.focusOffset).toBe("two".length);
  });

  test("a single-root childless forest welds the tail onto the anchor itself", () => {
    const p = plan("one\n\n", "HEAD ", " TAIL")!;
    expect(p.anchor.text).toBe("HEAD one TAIL");
    expect(p.inserts).toEqual([]);
    expect(p.focusId).toBe("A");
    expect(p.focusOffset).toBe("HEAD one".length);
  });

  test.each<[string, string, string, PlannedAnchor]>([
    [
      "a task marker on line 1 converts the anchor when head is empty",
      "- [x] done\nb",
      "",
      { text: "done", isTask: true, completed: true, kind: null },
    ],
    [
      "a task marker mid-sentence leaves the anchor's kind alone",
      "- [x] done\nb",
      "mid-sentence ",
      { text: "mid-sentence done", isTask: null, completed: null, kind: null },
    ],
    [
      "a plain first line never un-tasks the anchor",
      "- plain\nb",
      "",
      { text: "plain", isTask: null, completed: null, kind: null },
    ],
    // ADR 0044's amendment: multi-line prose pastes land as paragraphs.
    [
      "a marker-less line 1 makes the anchor a paragraph when head is empty",
      "plain\nb",
      "",
      { text: "plain", isTask: null, completed: null, kind: "paragraph" },
    ],
    [
      "a marker-less line 1 mid-sentence leaves the anchor's kind alone",
      "plain\nb",
      "mid-sentence ",
      { text: "mid-sentence plain", isTask: null, completed: null, kind: null },
    ],
  ])("%s", (_name, md, head, expected) => {
    expect(plan(md, head)!.anchor).toEqual(expected);
  });

  test("literal paste infers no kind at all", () => {
    const p = planMarkdownPaste({
      index: fixture(),
      anchorId: "A",
      placement: "sibling",
      forest: parseMarkdownForest("plain\nb", { literal: true }),
      head: "",
      tail: "",
      newId: () => "p0",
    })!;
    expect(p.anchor.kind).toBeNull();
    expect(p.inserts[0]!.kind).toBeNull();
  });

  test("the zoomed title takes remaining roots as prepended children", () => {
    const p = plan("one\n  two\nthree", "", "", "child-prepend")!;
    expect(p.anchor.text).toBe("one");
    expect(p.inserts.map((i) => [i.id, i.parentId, i.prevSiblingId])).toEqual([
      ["p0", "A", null], // child of line 1
      ["p1", "A", "p0"], // the second root, demoted to a child
    ]);
    expect(p.repoints).toEqual([{ id: "kid", prevSiblingId: "p1" }]);
  });

  test("inserts are depth-first pre-order with the sibling chain wired", () => {
    const p = plan("one\nA\n  A1\n  A2\nB")!;
    expect(
      p.inserts.map((i) => `${i.text}:${i.parentId}:${i.prevSiblingId}`),
    ).toEqual(["A:null:A", "A1:p0:null", "A2:p0:p1", "B:null:p0"]);
  });

  test("an all-blank paste plans nothing", () => {
    expect(plan("\n\n")).toBeNull();
  });
});
