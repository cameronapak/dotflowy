/**
 * Pure-logic tests for the shared OPML export core (src/data/opml-export.ts,
 * ADR 0037): the Workflowy dialect (`_complete` present-iff-true, two-layer
 * escaping, `&#10;`), the invented extensions (`_task`, the mirror dialect),
 * the inline inverse projections, and the acceptance round-trip — a
 * mirror-bearing export re-imports with the mirror RE-LINKED.
 */

import { describe, expect, it } from "bun:test";
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
import { buildTreeIndex, makeNode, type TreeIndex } from "./tree";

const index = (nodes: Node[]): TreeIndex => buildTreeIndex(nodes);
const reimport = (opml: string): OpmlImportResult =>
  Effect.runSync(parseOpml(opml));

describe("document shape", () => {
  const idx = index([
    makeNode({ id: "a", text: "alpha" }),
    makeNode({
      id: "b",
      parentId: "a",
      text: "bravo",
      isTask: true,
      completed: true,
    }),
  ]);
  const out = exportOpml(idx, null, { title: "my export" });

  it("emits the OPML 2.0 shell with a title-only head (no ownerEmail)", () => {
    expect(out).toContain('<?xml version="1.0"?>');
    expect(out).toContain('<opml version="2.0">');
    expect(out).toContain("<title>my export</title>");
    expect(out).not.toContain("ownerEmail");
  });

  it("emits _complete and _task present-iff-true", () => {
    expect(out).toContain(
      '<outline _complete="true" _task="true" text="bravo" />',
    );
    // The parent has neither flag — no attribute noise.
    expect(out).toContain('<outline text="alpha">');
  });

  it("emits _kind only for a paragraph (ADR 0045)", () => {
    const withPara = buildTreeIndex([
      makeNode({ id: "a", text: "alpha" }),
      makeNode({ id: "p", parentId: "a", text: "prose", kind: "paragraph" }),
    ]);
    const opml = exportOpml(withPara, null, { title: "t" });
    expect(opml).toContain('<outline _kind="paragraph" text="prose" />');
    expect(opml).toContain('<outline text="alpha">');
  });

  it("drops view state and provenance: no collapsed/bookmarked/origin/timestamps", () => {
    for (const forbidden of [
      "collapsed",
      "bookmarked",
      "origin",
      "createdAt",
    ]) {
      expect(out).not.toContain(forbidden);
    }
  });

  it("scopes to a zoom root, root included", () => {
    const zoomed = exportOpml(idx, "b", { title: "t" });
    expect(zoomed).toContain("bravo");
    expect(zoomed).not.toContain("alpha");
  });
});

describe("escaping (the two layers, in reverse)", () => {
  it("double-escapes a literal < (byte-matching Workflowy) and encodes quotes", () => {
    const idx = index([makeNode({ id: "a", text: `a < b & "c" 'd'` })]);
    const out = exportOpml(idx, null, { title: "t" });
    expect(out).toContain(
      'text="a &amp;lt; b &amp;amp; &amp;quot;c&amp;quot; &#39;d&#39;"',
    );
  });

  it("round-trips special characters byte-exact through import", () => {
    const text = `a < b & "c" 'd' > e`;
    const idx = index([makeNode({ id: "a", text })]);
    const { forest } = reimport(exportOpml(idx, null, { title: "t" }));
    expect(forest[0]!.text).toBe(text);
  });

  it("escapes a newline in text as &#10;", () => {
    const idx = index([makeNode({ id: "a", text: "one\ntwo" })]);
    expect(exportOpml(idx, null, { title: "t" })).toContain(
      'text="one&#10;two"',
    );
  });
});

describe("inline inverse projections", () => {
  const project = (text: string, extra: Node[] = []): string =>
    exportOpml(index([makeNode({ id: "a", text }), ...extra]), null, {
      title: "t",
    });

  it("projects emphasis, code, and links to Workflowy HTML", () => {
    const out = project("**b** *i* ~u~ ~~s~~ `c` [l](https://e.com)");
    expect(out).toContain("&lt;b&gt;b&lt;/b&gt;");
    expect(out).toContain("&lt;i&gt;i&lt;/i&gt;");
    expect(out).toContain("&lt;u&gt;u&lt;/u&gt;");
    expect(out).toContain("&lt;s&gt;s&lt;/s&gt;");
    expect(out).toContain("&lt;code&gt;c&lt;/code&gt;");
    expect(out).toContain(
      "&lt;a href=&quot;https://e.com&quot;&gt;l&lt;/a&gt;",
    );
  });

  it("exports the underscore italic alias identically to *i*", () => {
    expect(project("_i_")).toContain("&lt;i&gt;i&lt;/i&gt;");
  });

  it("projects highlights to bc-* classes, emoji stripped (blue -> bc-sky)", () => {
    const out = project("==plain== and ==🔴hot==");
    expect(out).toContain(
      "&lt;mark class=&quot;colored bc-sky&quot;&gt;plain&lt;/mark&gt;",
    );
    expect(out).toContain(
      "&lt;mark class=&quot;colored bc-red&quot;&gt;hot&lt;/mark&gt;",
    );
    expect(out).not.toContain("🔴");
  });

  it("rebuilds <time start…> from the date token with regenerated display", () => {
    const out = project("due [[2026-07-08]]");
    expect(out).toContain(
      "&lt;time startYear=&quot;2026&quot; startMonth=&quot;7&quot; startDay=&quot;8&quot;&gt;Wed, Jul 8, 2026&lt;/time&gt;",
    );
  });

  it("carries the token time into startHour (no startMinute for :00)", () => {
    const out = project("[[2024-02-03 13:00]]");
    expect(out).toContain("startHour=&quot;13&quot;");
    expect(out).not.toContain("startMinute");
    expect(out).toContain("at 1:00pm");
  });

  it("projects node links to app URLs labeled with the flattened target text", () => {
    const targetId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const out = project(`see [[${targetId}]]`, [
      makeNode({ id: targetId, text: "target **bold**" }),
    ]);
    expect(out).toContain(
      `&lt;a href=&quot;https://app.dotflowy.com/${targetId}&quot;&gt;target bold&lt;/a&gt;`,
    );
  });

  it("projects Bible refs to route.bible links", () => {
    const out = project("read John 3:16 today");
    expect(out).toContain("route.bible");
    expect(out).toContain("&gt;John 3:16&lt;/a&gt;");
  });

  it("passes #tags and literal markers through as plain text", () => {
    const out = project("#tag and a lone * star");
    expect(out).toContain('text="#tag and a lone * star"');
  });
});

describe("mirror dialect", () => {
  const nodes = [
    makeNode({ id: "src", text: "source" }),
    makeNode({ id: "kid", parentId: "src", text: "kid" }),
    makeNode({
      id: "mir",
      text: "source",
      mirrorOf: "src",
      prevSiblingId: "src",
    }),
  ];

  it("emits id on the in-scope source and _mirror over a resolved duplicate", () => {
    const out = exportOpml(index(nodes), null, { title: "t" });
    expect(out).toContain('id="src"');
    expect(out).toContain('_mirror="src"');
    // The mirror expands the full resolved duplicate — the kid appears twice.
    expect(out.split('text="kid"').length - 1).toBe(2);
  });

  it("caps a mirror cycle: a mirror of its own ancestor emits no children", () => {
    const cyclic = index([
      makeNode({ id: "a", text: "ancestor" }),
      makeNode({ id: "m", parentId: "a", text: "ancestor", mirrorOf: "a" }),
    ]);
    const out = exportOpml(cyclic, null, { title: "t" });
    // The mirror row is self-closing: its source is already on the path.
    expect(out).toContain('<outline _mirror="a" text="ancestor" />');
  });
});

describe("round-trip: export -> import re-links mirrors (the acceptance test)", () => {
  const nodes = [
    makeNode({ id: "src", text: "source **bold**" }),
    makeNode({
      id: "kid",
      parentId: "src",
      text: "kid ==🟢go== [[2026-07-08]]",
    }),
    makeNode({
      id: "mir",
      text: "source **bold**",
      mirrorOf: "src",
      prevSiblingId: "src",
    }),
    makeNode({ id: "p", text: "plain `code` last", prevSiblingId: "mir" }),
  ];
  const opml = exportOpml(index(nodes), null, { title: "round trip" });
  const { forest, report } = reimport(opml);

  it("re-links the mirror and drops its duplicate subtree", () => {
    expect(report.mirrorsLinked).toBe(1);
    expect(report.mirrorsDetached).toBe(0);
    expect(forest[1]!.mirrorOfOpmlId).toBe("src");
    expect(forest[1]!.children).toEqual([]);
  });

  it("round-trips formatted text byte-exact", () => {
    expect(forest[0]!.text).toBe("source **bold**");
    expect(forest[0]!.children[0]!.text).toBe("kid ==🟢go== [[2026-07-08]]");
    expect(forest[2]!.text).toBe("plain `code` last");
    expect(report.degradedTotal).toBe(0);
  });

  it("plans the re-imported forest with a REAL mirror pointer", () => {
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
});
