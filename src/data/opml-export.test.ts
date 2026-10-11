/**
 * Pure-logic tests for the shared OPML export core (src/data/opml-export.ts,
 * ADR 0037): the Workflowy dialect (`_complete` present-iff-true, two-layer
 * escaping, `&#10;`), the invented extensions (`_task`, `_kind`, the mirror
 * dialect), the inline inverse projections, and the acceptance round-trip -- a
 * mirror-bearing export re-imports with the mirror RE-LINKED.
 */

import { expect, test } from "bun:test";
import { Effect } from "effect";

import type { ChangeOp, Node } from "./wire-schema";

import { exportOpml } from "./opml-export";
import {
  OpmlEmpty,
  OpmlImportTooLarge,
  parseOpml,
  planOpmlImport,
  type OpmlImportResult,
} from "./opml-import";
import { buildTreeIndex, createNode } from "./tree";

const exportNodes = (nodes: Node[], rootId: string | null = null): string =>
  exportOpml(buildTreeIndex(nodes), rootId, { title: "t" });
const reimport = (opml: string): OpmlImportResult =>
  Effect.runSync(parseOpml(opml));

test("document shape: shell, present-iff-true flags, no view state, zoom scope", () => {
  const nodes = [
    createNode({
      id: "a",
      text: "alpha",
      collapsed: true,
      bookmarkedAt: 1234567,
      origin: "test-agent",
    }),
    createNode({
      id: "b",
      parentId: "a",
      text: "bravo",
      isTask: true,
      completed: true,
    }),
    createNode({
      id: "p",
      parentId: "a",
      prevSiblingId: "b",
      text: "prose",
      kind: "paragraph",
    }),
  ];
  const out = exportOpml(buildTreeIndex(nodes), null, { title: "my export" });

  expect(out).toContain('<?xml version="1.0"?>');
  expect(out).toContain('<opml version="2.0">');
  expect(out).toContain("<title>my export</title>");
  expect(out).toContain(
    '<outline _complete="true" _task="true" text="bravo" />',
  );
  // `_kind` only for a paragraph (ADR 0045).
  expect(out).toContain('<outline _kind="paragraph" text="prose" />');
  // The parent has no flag set, so no attribute noise -- and its view state
  // and provenance stay out of the file.
  expect(out).toContain('<outline text="alpha">');
  for (const dropped of [
    "collapsed",
    "bookmarked",
    "origin",
    "test-agent",
    "createdAt",
    "1234567",
  ]) {
    expect(out).not.toContain(dropped);
  }

  // A zoom root scopes the export, root included.
  const zoomed = exportNodes(nodes, "b");
  expect(zoomed).toContain("bravo");
  expect(zoomed).not.toContain("alpha");
});

test("escaping: a literal < double-escapes (byte-matching Workflowy) and round-trips", () => {
  const text = `a < b & "c" 'd' > e`;
  const out = exportNodes([createNode({ id: "a", text })]);
  expect(out).toContain(
    'text="a &amp;lt; b &amp;amp; &amp;quot;c&amp;quot; &#39;d&#39; &amp;gt; e"',
  );
  expect(reimport(out).forest[0]!.text).toBe(text);
});

test("escaping: a newline in text is &#10;", () => {
  expect(exportNodes([createNode({ id: "a", text: "one\ntwo" })])).toContain(
    'text="one&#10;two"',
  );
});

test.each<[string, string, string[]]>([
  [
    "emphasis, code, and links project to Workflowy HTML",
    "**b** *i* ~u~ ~~s~~ `c` [l](https://e.com)",
    [
      "&lt;b&gt;b&lt;/b&gt;",
      "&lt;i&gt;i&lt;/i&gt;",
      "&lt;u&gt;u&lt;/u&gt;",
      "&lt;s&gt;s&lt;/s&gt;",
      "&lt;code&gt;c&lt;/code&gt;",
      "&lt;a href=&quot;https://e.com&quot;&gt;l&lt;/a&gt;",
    ],
  ],
  [
    "the underscore italic alias exports like *i*",
    "_i_",
    ["&lt;i&gt;i&lt;/i&gt;"],
  ],
  [
    "highlights project to bc-* classes (bare blue -> bc-sky)",
    "==plain== and ==🔴hot==",
    [
      "&lt;mark class=&quot;colored bc-sky&quot;&gt;plain&lt;/mark&gt;",
      "&lt;mark class=&quot;colored bc-red&quot;&gt;hot&lt;/mark&gt;",
    ],
  ],
  [
    "the date token rebuilds <time start...> with a regenerated display",
    "due [[2026-07-08]]",
    [
      "&lt;time startYear=&quot;2026&quot; startMonth=&quot;7&quot; startDay=&quot;8&quot;&gt;Wed, Jul 8, 2026&lt;/time&gt;",
    ],
  ],
  [
    "the token time carries into startHour",
    "[[2024-02-03 13:00]]",
    ["startHour=&quot;13&quot;", "at 1:00pm"],
  ],
  [
    "Bible refs project to route.bible links",
    "read John 3:16 today",
    ["route.bible", "&gt;John 3:16&lt;/a&gt;"],
  ],
  [
    "#tags and literal markers pass through as plain text",
    "#tag and a lone * star",
    ['text="#tag and a lone * star"'],
  ],
])("inline projection: %s", (_name, text, fragments) => {
  const out = exportNodes([createNode({ id: "a", text })]);
  for (const fragment of fragments) expect(out).toContain(fragment);
});

test("inline projection: a highlight's color emoji and a :00 minute stay out", () => {
  expect(
    exportNodes([createNode({ id: "a", text: "==🔴hot==" })]),
  ).not.toContain("🔴");
  expect(
    exportNodes([createNode({ id: "a", text: "[[2024-02-03 13:00]]" })]),
  ).not.toContain("startMinute");
});

test("inline projection: node links become app URLs labeled with flattened target text", () => {
  const targetId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const out = exportNodes([
    createNode({ id: "a", text: `see [[${targetId}]]` }),
    createNode({ id: targetId, text: "target **bold**" }),
  ]);
  expect(out).toContain(
    `&lt;a href=&quot;https://app.dotflowy.com/${targetId}&quot;&gt;target bold&lt;/a&gt;`,
  );
});

test("mirror dialect: id on the in-scope source, _mirror over a resolved duplicate", () => {
  const out = exportNodes([
    createNode({ id: "src", text: "source" }),
    createNode({ id: "kid", parentId: "src", text: "kid" }),
    createNode({
      id: "mir",
      text: "source",
      mirrorOf: "src",
      prevSiblingId: "src",
    }),
  ]);
  expect(out).toContain('id="src"');
  expect(out).toContain('_mirror="src"');
  // The mirror expands the full resolved duplicate -- the kid appears twice.
  expect(out.split('text="kid"').length - 1).toBe(2);
});

test("mirror dialect: a mirror of its own ancestor emits no children", () => {
  const out = exportNodes([
    createNode({ id: "a", text: "ancestor" }),
    createNode({ id: "m", parentId: "a", text: "ancestor", mirrorOf: "a" }),
  ]);
  // The mirror row is self-closing: its source is already on the path.
  expect(out).toContain('<outline _mirror="a" text="ancestor" />');
});

test("round-trip: export -> import -> plan re-links the mirror, text byte-exact", () => {
  const opml = exportNodes([
    createNode({ id: "src", text: "source **bold**" }),
    createNode({
      id: "kid",
      parentId: "src",
      text: "kid ==🟢go== [[2026-07-08]]",
    }),
    createNode({
      id: "mir",
      text: "source **bold**",
      mirrorOf: "src",
      prevSiblingId: "src",
    }),
    createNode({ id: "p", text: "plain `code` last", prevSiblingId: "mir" }),
  ]);
  const { forest, report } = reimport(opml);

  expect(report.mirrorsLinked).toBe(1);
  expect(report.mirrorsDetached).toBe(0);
  expect(forest[1]!.mirrorOfOpmlId).toBe("src");
  expect(forest[1]!.children).toEqual([]);
  expect(forest[0]!.text).toBe("source **bold**");
  expect(forest[0]!.children[0]!.text).toBe("kid ==🟢go== [[2026-07-08]]");
  expect(forest[2]!.text).toBe("plain `code` last");
  expect(report.degradedTotal).toBe(0);

  let n = 0;
  const plan = planOpmlImport(forest, {
    parentId: null,
    firstPrev: null,
    timestamp: 7,
    newId: () => `new${++n}`,
    maxNodes: 100,
  });
  if (plan instanceof OpmlEmpty || plan instanceof OpmlImportTooLarge) {
    throw new Error("expected a plan");
  }
  const inserted = plan.ops.flatMap((op: ChangeOp) =>
    op.op === "insert" ? [op.value] : [],
  );
  const source = inserted.find(
    (v) => v.text === "source **bold**" && v.mirrorOf === null,
  )!;
  const mirror = inserted.find((v) => v.mirrorOf !== null)!;
  expect(mirror.mirrorOf).toBe(source.id);
});
