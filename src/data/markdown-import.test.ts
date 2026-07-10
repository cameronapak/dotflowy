import { describe, expect, test } from "bun:test";

import { outlineToMarkdown } from "./markdown";
import {
  countForest,
  parseMarkdownForest,
  planMarkdownPaste,
  type MdNode,
} from "./markdown-import";
import { buildTreeIndex, makeNode, type Node } from "./tree";

// --- helpers ------------------------------------------------------------------

/** The shape the round-trip compares: `outlineToMarkdown` carries text, task
 *  state, and structure -- nothing else. */
interface Shape {
  text: string;
  isTask: boolean;
  completed: boolean;
  children: Shape[];
}

const shape = (
  text: string,
  children: Shape[] = [],
  isTask = false,
  completed = false,
): Shape => ({ text, isTask, completed, children });

const forestShape = (forest: readonly MdNode[]): Shape[] =>
  forest.map((n) => ({
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    children: forestShape(n.children),
  }));

/** Materialize a `Shape` forest into a `TreeIndex`, wiring the sibling chain.
 *  `mirrors` maps a node's index-path label to the id it mirrors. */
function buildIndex(forest: Shape[], mirrorOf: Record<string, string> = {}) {
  const nodes: Node[] = [];
  let n = 0;
  const walk = (siblings: Shape[], parentId: string | null): void => {
    let prev: string | null = null;
    for (const node of siblings) {
      const id = `n${n++}`;
      nodes.push(
        makeNode({
          id,
          parentId,
          prevSiblingId: prev,
          text: node.text,
          isTask: node.isTask,
          completed: node.completed,
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
  forest: Shape[],
  mirrorOf: Record<string, string> = {},
): Shape[] {
  const { index } = buildIndex(forest, mirrorOf);
  const roots = index.childrenByParent.get("__root__") ?? [];
  const md = outlineToMarkdown(index, roots);
  return forestShape(parseMarkdownForest(md));
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

function randomForest(next: () => number, depth = 0): Shape[] {
  const count = Math.floor(next() * (depth === 0 ? 5 : 3));
  const out: Shape[] = [];
  for (let i = 0; i < count; i++) {
    const isTask = next() < 0.25;
    out.push({
      text: TEXTS[Math.floor(next() * TEXTS.length)]!,
      isTask,
      completed: isTask && next() < 0.5,
      children: depth < 3 ? randomForest(next, depth + 1) : [],
    });
  }
  return out;
}

// --- the invariant ------------------------------------------------------------

describe("parse(outlineToMarkdown(t)) === t", () => {
  test("holds over generated trees", () => {
    const next = rng(0xd07f10);
    for (let i = 0; i < 300; i++) {
      const forest = randomForest(next);
      if (forest.length === 0) continue;
      expect(roundTrip(forest)).toEqual(forest);
    }
  });

  test("holds for a single empty bullet (`- ` is eaten by editors)", () => {
    expect(roundTrip([shape("")])).toEqual([shape("")]);
  });

  test("holds for a task with no text", () => {
    expect(roundTrip([shape("", [], true, false)])).toEqual([
      shape("", [], true, false),
    ]);
    expect(roundTrip([shape("", [], true, true)])).toEqual([
      shape("", [], true, true),
    ]);
  });

  test("exception 3: a mirror flattens to an independent copy", () => {
    // n0 "source" > n1 "kid"; n2 mirrors n0.
    const { index } = buildIndex([shape("source", [shape("kid")]), shape("")], {
      n2: "n0",
    });
    const md = outlineToMarkdown(index, ["n0", "n2"]);
    expect(md).toBe(["- source", "  - kid", "- source", "  - kid"].join("\n"));
    // ...and the copy round-trips as a plain subtree.
    expect(forestShape(parseMarkdownForest(md))).toEqual([
      shape("source", [shape("kid")]),
      shape("source", [shape("kid")]),
    ]);
  });

  test("exception 3: a mirror inside its own source emits once and stops", () => {
    // n0 "source" > n1 mirrors n0 -- expanding it forever is the cycle.
    const { index } = buildIndex([shape("source", [shape("snapshot")])], {
      n1: "n0",
    });
    expect(outlineToMarkdown(index, ["n0"])).toBe(
      ["- source", "  - source"].join("\n"),
    );
  });

  test("exception 3: one source mirrored into two branches expands in both", () => {
    const { index } = buildIndex(
      [
        shape("src", [shape("kid")]),
        shape("a", [shape("")]),
        shape("b", [shape("")]),
      ],
      { n3: "n0", n5: "n0" },
    );
    expect(outlineToMarkdown(index, ["n2", "n4"])).toBe(
      ["- a", "  - src", "    - kid", "- b", "  - src", "    - kid"].join("\n"),
    );
  });

  test("exception 2: `[ ] x` as literal text re-imports as a task", () => {
    expect(roundTrip([shape("[ ] buy milk")])).toEqual([
      shape("buy milk", [], true, false),
    ]);
  });

  test("leading whitespace survives -- the marker eats exactly one space", () => {
    // `- ` + `  x` exports as `-   x`. Consuming `\s+` there would drop the two
    // spaces, flattening the indentation of every fence interior the fence rule
    // promises to keep (a pasted code block, copied back out, came back at
    // column zero). See ADR 0044.
    expect(roundTrip([shape("  x")])).toEqual([shape("  x")]);
    expect(roundTrip([shape("\tx")])).toEqual([shape("\tx")]);
    expect(roundTrip([shape("    if x:", [], true, false)])).toEqual([
      shape("    if x:", [], true, false),
    ]);
  });

  test("a pasted code fence survives being copied back out", () => {
    // The end-to-end shape of the bug above: paste Python, copy as markdown,
    // paste it back. Every level of indentation must still be there.
    const src = [
      "```py",
      "def f():",
      "    if x:",
      "        return 1",
      "```",
    ].join("\n");
    const once = forestShape(parseMarkdownForest(src));
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

describe("parseMarkdownForest", () => {
  const texts = (md: string) => parseMarkdownForest(md).map((n) => n.text);

  test("one line, one bullet -- no paragraph continuation", () => {
    expect(texts("alpha\nbravo\ncharlie")).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  test("drops blank lines as separators", () => {
    expect(texts("a\n\n\nb")).toEqual(["a", "b"]);
  });

  test("a single trailing newline is a terminator, not an empty bullet", () => {
    expect(texts("a\nb\n")).toEqual(["a", "b"]);
  });

  test("strips exactly one list marker, never recursing", () => {
    expect(texts("- - foo")).toEqual(["- foo"]);
    expect(texts("- # foo")).toEqual(["# foo"]);
    expect(texts("1. one\n2) two\n* star\n+ plus")).toEqual([
      "one",
      "two",
      "star",
      "plus",
    ]);
  });

  test("consumes exactly one space after the marker, so padding is content", () => {
    expect(texts("- item")).toEqual(["item"]);
    expect(texts("-\titem")).toEqual(["item"]);
    // The deliberate divergence from lenient markdown readers: `outlineToMarkdown`
    // emits one space, so the rest is text. Foreign padding survives as leading
    // whitespace rather than silently eating a fence interior's indent.
    expect(texts("-   item")).toEqual(["  item"]);
    expect(texts("- [ ]   item")).toEqual(["  item"]);
  });

  test("a bare marker is an empty node, never a dropped line", () => {
    expect(texts("- a\n-\n- \n*")).toEqual(["a", "", "", ""]);
  });

  test("`*bold*` is not a bullet (a marker needs trailing space or EOL)", () => {
    expect(texts("*bold* text")).toEqual(["*bold* text"]);
  });

  test("heading detection requires the space, so `#urgent` stays a tag", () => {
    expect(texts("#urgent")).toEqual(["#urgent"]);
    expect(texts("####### seven")).toEqual(["####### seven"]);
    expect(texts("# urgent")).toEqual(["urgent"]);
  });

  test("headings drive nesting, and the shallowest normalizes to depth 0", () => {
    const forest = parseMarkdownForest("### Section\nbody\n#### Sub\nmore");
    expect(forestShape(forest)).toEqual([
      shape("Section", [shape("body"), shape("Sub", [shape("more")])]),
    ]);
  });

  test("a skipped heading level clamps instead of jumping", () => {
    const forest = parseMarkdownForest("# A\n##### E\ntext");
    expect(forestShape(forest)).toEqual([
      shape("A", [shape("E", [shape("text")])]),
    ]);
  });

  test("a heading pops back out to its own level", () => {
    const forest = parseMarkdownForest("# A\n## B\n# C");
    expect(forestShape(forest)).toEqual([shape("A", [shape("B")]), shape("C")]);
  });

  test("list indentation nests inside the heading floor", () => {
    const forest = parseMarkdownForest("# A\n- one\n  - two");
    expect(forestShape(forest)).toEqual([
      shape("A", [shape("one", [shape("two")])]),
    ]);
  });

  test("tabs, 2-space and 4-space indents all nest identically", () => {
    const expected = [shape("a", [shape("b", [shape("c")])])];
    expect(forestShape(parseMarkdownForest("- a\n  - b\n    - c"))).toEqual(
      expected,
    );
    expect(
      forestShape(parseMarkdownForest("- a\n    - b\n        - c")),
    ).toEqual(expected);
    expect(forestShape(parseMarkdownForest("- a\n\t- b\n\t\t- c"))).toEqual(
      expected,
    );
  });

  test("a skipped indent level clamps to one level down", () => {
    expect(forestShape(parseMarkdownForest("- a\n        - b"))).toEqual([
      shape("a", [shape("b")]),
    ]);
  });

  test("task markers map to isTask/completed", () => {
    expect(
      forestShape(parseMarkdownForest("- [ ] open\n- [x] done\n- [X] DONE")),
    ).toEqual([
      shape("open", [], true, false),
      shape("done", [], true, true),
      shape("DONE", [], true, true),
    ]);
  });

  test("a task marker needs its list marker (GFM), so bare `[ ] x` is text", () => {
    expect(forestShape(parseMarkdownForest("[ ] x\ny"))).toEqual([
      shape("[ ] x"),
      shape("y"),
    ]);
  });

  test("`[]` with nothing inside is text, not a checkbox", () => {
    expect(texts("- [] x")).toEqual(["[] x"]);
  });

  test("blockquote markers strip; the text survives whole", () => {
    expect(texts("> quoted\n>> deeper\n> - listed")).toEqual([
      "quoted",
      "deeper",
      "listed",
    ]);
  });

  test("a quoted heading is not a heading (the grammar fires before any marker)", () => {
    // ADR 0044 rule 2: the heading grammar only fires at the start of a line's
    // content, before any marker, once. `>` is a marker, so `# A` survives as
    // literal text -- and re-exporting it (`- # A`) is a fixed point.
    expect(forestShape(parseMarkdownForest("> # A\n> body"))).toEqual([
      shape("# A"),
      shape("body"),
    ]);
  });

  test("fences suppress the grammar and keep their delimiters", () => {
    const forest = parseMarkdownForest(
      "```ts\n- not a bullet\n  indented\n\n```\nafter",
    );
    expect(forestShape(forest)).toEqual([
      shape("```ts"),
      shape("- not a bullet"),
      shape("  indented"),
      shape(""), // a blank line inside a fence is content
      shape("```"),
      shape("after"),
    ]);
  });

  test("a fence closes only on a bare delimiter of the same char", () => {
    const forest = parseMarkdownForest("```\n~~~\n```js\n```\nout");
    expect(forestShape(forest)).toEqual([
      shape("```"),
      shape("~~~"),
      shape("```js"),
      shape("```"),
      shape("out"),
    ]);
  });

  test("a re-pasted fence delimiter never re-fires", () => {
    // What `outlineToMarkdown` emits for the bullets above.
    expect(texts("- ```ts\n- const x = 1\n- ```")).toEqual([
      "```ts",
      "const x = 1",
      "```",
    ]);
  });

  test("literal mode: every line is one verbatim top-level bullet", () => {
    const forest = parseMarkdownForest("- a\n  - b\n# C\n```\nd", {
      literal: true,
    });
    expect(forestShape(forest)).toEqual([
      shape("- a"),
      shape("  - b"),
      shape("# C"),
      shape("```"),
      shape("d"),
    ]);
  });

  test("literal mode keeps a diff pasteable", () => {
    expect(
      parseMarkdownForest("- old\n+ new", { literal: true }).map((n) => n.text),
    ).toEqual(["- old", "+ new"]);
  });

  test("countForest counts the whole forest", () => {
    expect(countForest(parseMarkdownForest("- a\n  - b\n    - c\n- d"))).toBe(
      4,
    );
  });
});

// --- the landing --------------------------------------------------------------

describe("planMarkdownPaste", () => {
  // anchor "A" with an existing child "kid" and a following sibling "next".
  const fixture = () => {
    const a = makeNode({ id: "A", text: "anchor" });
    const next = makeNode({ id: "next", prevSiblingId: "A", text: "next" });
    const kid = makeNode({ id: "kid", parentId: "A", text: "kid" });
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
      },
      {
        id: "p1",
        parentId: null,
        prevSiblingId: "A",
        text: "three",
        isTask: false,
        completed: false,
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

  test("a task marker on line 1 converts the anchor only when head is empty", () => {
    expect(plan("- [x] done\nb")!.anchor).toEqual({
      text: "done",
      isTask: true,
      completed: true,
    });
    expect(plan("- [x] done\nb", "mid-sentence ")!.anchor).toEqual({
      text: "mid-sentence done",
      isTask: null,
      completed: null,
    });
  });

  test("a plain first line never un-tasks the anchor", () => {
    expect(plan("plain\nb")!.anchor).toEqual({
      text: "plain",
      isTask: null,
      completed: null,
    });
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
