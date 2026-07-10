/**
 * Pure-logic tests for the shared OPML import core (src/data/opml-import.ts,
 * ADR 0037). The headline acceptance: the crafted Workflowy sample
 * (docs/spec-assets/opml/workflowy-crafted-sample.opml) imports with the
 * EXACT degradation counts the fidelity probe reported
 * (docs/spec-assets/opml/fidelity-probe-report.md) — the "degraded, never
 * silent" bar, pinned. Plus the failure modes the parser was chosen for:
 * truncation fails with line/column (never a partial plan), the entity bomb
 * is rejected, and the raw-size guard fires before parsing.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import type { ChangeOp, Node } from "./wire-schema";

import {
  OpmlEmpty,
  OpmlImportTooLarge,
  OpmlParseError,
  OpmlTooLarge,
  parseOpml,
  planOpmlImport,
  type OpmlImportNode,
  type OpmlImportResult,
} from "./opml-import";

const SAMPLE_PATH = `${import.meta.dir}/../../docs/spec-assets/opml/workflowy-crafted-sample.opml`;
const sampleOpml = await Bun.file(SAMPLE_PATH).text();

const run = (src: string): OpmlImportResult => Effect.runSync(parseOpml(src));
const runFail = (src: string, options?: { maxLength?: number }) =>
  Effect.runSync(Effect.flip(parseOpml(src, options)));

/** Wrap an escaped body in a minimal OPML shell. */
const doc = (body: string): string =>
  `<?xml version="1.0"?>\n<opml version="2.0"><head></head><body>${body}</body></opml>`;

describe("crafted Workflowy sample (the fidelity-probe pin)", () => {
  const { forest, report } = run(sampleOpml);
  const root = forest[0]!;
  const texts = root.children.map((c) => c.text);

  it("reproduces the probe scale numbers: 21 pre -> 23 post-split", () => {
    expect(report.nodesPre).toBe(21);
    expect(report.nodesPost).toBe(23);
    expect(report.emptyText).toBe(0);
    expect(report.textNewlineSplits).toBe(0);
  });

  it("reproduces the probe degradation counts EXACTLY", () => {
    expect(report.degraded).toEqual({
      "nested <mark> dropped (outermost wins)": 2,
      "<mention> -> @mention(id) (name unrecoverable)": 1,
    });
    expect(report.degradedTotal).toBe(3);
  });

  it("reproduces the probe note split: 1 note -> 2 bullets, 1 blank dropped", () => {
    expect(report.notes).toBe(1);
    expect(report.noteLines).toBe(2);
    expect(report.noteBlanksDropped).toBe(1);
  });

  it("finds no anomalies, no unknown attributes, no mirrors in the sample", () => {
    expect(report.anomalies).toEqual({});
    expect(report.unknownAttributes).toEqual({});
    expect(report.mirrorsLinked).toBe(0);
    expect(report.mirrorsDetached).toBe(0);
  });

  it("two-layer decodes: &amp;lt; survives as a literal <", () => {
    expect(texts[0]).toBe(
      "plain text with special chars < > & \" ' and emoji 🙂🚀",
    );
  });

  it("maps the emphasis/code tags to the shipped tokens", () => {
    expect(texts[1]).toBe("**bold text**");
    expect(texts[2]).toBe("*italic text*");
    expect(texts[3]).toBe("~underline text~");
    expect(texts[4]).toBe("~~strikethrough and colored text~~"); // nested marks dropped
    expect(texts[5]).toBe("`inline code text`");
  });

  it("maps <a> to [label](url) with the XML layer decoded", () => {
    expect(texts[6]).toBe("[a labeled link](https://example.com/path?q=1&r=2)");
    expect(texts[7]).toBe(
      "bare url [https://workflowy.com](https://workflowy.com) in text",
    );
  });

  it("adopts <time> as the ADR 0038 date token, keyed on canonical attrs", () => {
    expect(texts[8]).toBe("due [[2026-07-08]] ");
  });

  it("splits the _note into prepended child bullets, blanks dropped", () => {
    const noteNode = root.children[9]!;
    expect(noteNode.text).toBe("bullet with a multi-line note");
    expect(noteNode.children.map((c) => c.text)).toEqual([
      "note line one with a link [https://example.com/notes?x=1&y=2](https://example.com/notes?x=1&y=2)",
      "note line two after a hard newline",
    ]);
  });

  it("degrades <mention> to the @mention(id) placeholder", () => {
    expect(texts[10]).toBe(
      "tagged #dotflowy #import-test and a mention @mention(2544228)  and a tag-style time @work",
    );
  });

  it("honors _complete and keeps deep nesting intact", () => {
    expect(root.children[11]!.completed).toBe(true);
    let cursor = root.children[14]!;
    const chain = [cursor.text];
    while (cursor.children.length) {
      cursor = cursor.children[0]!;
      chain.push(cursor.text);
    }
    expect(chain).toEqual([
      "level 1 of deep nesting",
      "level 2",
      "level 3",
      "level 4",
      "level 5",
      "level 6 deepest",
    ]);
  });
});

describe("tolerant inline-HTML scanner", () => {
  it("tolerates cross-bullet <b> spans: text kept, anomalies counted", () => {
    const { forest, report } = run(
      doc(
        '<outline text="see &lt;b&gt;bold start" />' +
          '<outline text="end&lt;/b&gt; here" />',
      ),
    );
    // The unclosed <b> auto-closes at end of value (still a bold run); the
    // stray </b> is ignored. Nothing is rejected, nothing lost.
    expect(forest[0]!.text).toBe("see **bold start**");
    expect(forest[1]!.text).toBe("end here");
    expect(report.anomalies).toEqual({ "unclosed <b>": 1, "stray </b>": 1 });
  });

  it("drops formatting on a marker-char clash, keeping the text", () => {
    const { forest, report } = run(
      doc('<outline text="&lt;b&gt;a*b&lt;/b&gt;" />'),
    );
    expect(forest[0]!.text).toBe("a*b");
    expect(report.degraded["<b> dropped: marker char in interior"]).toBe(1);
  });

  it("link wins over formatting: styling dropped, link intact", () => {
    const { forest, report } = run(
      doc(
        '<outline text="&lt;b&gt;&lt;a href=&quot;https://e.com&quot;&gt;go&lt;/a&gt;&lt;/b&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("[go](https://e.com)");
    expect(report.degraded["<b> dropped: contains a link (link wins)"]).toBe(1);
  });

  it("strips unknown tags to their inner text, counted", () => {
    const { forest, report } = run(
      doc('<outline text="&lt;span&gt;kept&lt;/span&gt;" />'),
    );
    expect(forest[0]!.text).toBe("kept");
    expect(report.degraded["unknown <span> stripped, text kept"]).toBe(1);
  });

  it("maps gray marks to the bare default run (no white in the palette)", () => {
    const { forest, report } = run(
      doc(
        '<outline text="&lt;mark class=&quot;colored bc-gray&quot;&gt;g&lt;/mark&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("==g==");
    expect(
      report.degraded["<mark gray> -> bare == (no white in the palette)"],
    ).toBe(1);
  });

  it("canonicalizes bc-sky to the BARE default-blue run", () => {
    const { forest } = run(
      doc(
        '<outline text="&lt;mark class=&quot;colored bc-sky&quot;&gt;s&lt;/mark&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("==s==");
  });

  it("maps bc-red to the red-emoji run", () => {
    const { forest } = run(
      doc(
        '<outline text="&lt;mark class=&quot;colored bc-red&quot;&gt;hot&lt;/mark&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("==🔴hot==");
  });
});

describe("<time> mapping (ADR 0038)", () => {
  it("carries startHour into the token time", () => {
    const { forest } = run(
      doc(
        '<outline text="&lt;time startYear=&quot;2024&quot; startMonth=&quot;2&quot; startDay=&quot;3&quot; startHour=&quot;13&quot;&gt;Sat, Feb 3, 2024 at 1:00pm&lt;/time&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("[[2024-02-03 13:00]]");
  });

  it("keeps the display text when the attrs are not a real calendar day", () => {
    const { forest, report } = run(
      doc(
        '<outline text="&lt;time startYear=&quot;2026&quot; startMonth=&quot;13&quot; startDay=&quot;45&quot;&gt;bogus date&lt;/time&gt;" />',
      ),
    );
    expect(forest[0]!.text).toBe("bogus date");
    expect(
      report.degraded[
        "<time> missing canonical start attrs -> display text kept"
      ],
    ).toBe(1);
  });

  it("keeps the display text when the canonical attrs are missing", () => {
    const { forest, report } = run(
      doc('<outline text="&lt;time&gt;someday&lt;/time&gt;" />'),
    );
    expect(forest[0]!.text).toBe("someday");
    expect(
      report.degraded[
        "<time> missing canonical start attrs -> display text kept"
      ],
    ).toBe(1);
  });
});

describe("text newlines and notes", () => {
  it("splits &#10; in text into continuation bullets BEFORE note lines", () => {
    const { forest, report } = run(
      doc('<outline text="first&#10;second" _note="note line" />'),
    );
    expect(forest[0]!.text).toBe("first");
    expect(forest[0]!.children.map((c) => c.text)).toEqual([
      "second",
      "note line",
    ]);
    expect(report.textNewlineSplits).toBe(1);
    expect(report.notes).toBe(1);
    expect(report.noteLines).toBe(1);
  });
});

describe("mirror re-link (the dotflowy dialect)", () => {
  it("re-links a _mirror to an in-document id and drops the duplicate subtree", () => {
    const { forest, report } = run(
      doc(
        '<outline id="src1" text="source"><outline text="kid" /></outline>' +
          '<outline _mirror="src1" text="source"><outline text="kid" /></outline>',
      ),
    );
    expect(report.mirrorsLinked).toBe(1);
    expect(report.mirrorsDetached).toBe(0);
    const mirror = forest[1]!;
    expect(mirror.mirrorOfOpmlId).toBe("src1");
    expect(mirror.children).toEqual([]);
    expect(forest[0]!.opmlId).toBe("src1");
    expect(forest[0]!.children.map((c) => c.text)).toEqual(["kid"]);
  });

  it("imports an unresolvable _mirror as a disclosed detached copy", () => {
    const { forest, report } = run(
      doc(
        '<outline _mirror="gone" text="copy"><outline text="kid" /></outline>',
      ),
    );
    expect(report.mirrorsLinked).toBe(0);
    expect(report.mirrorsDetached).toBe(1);
    expect(
      report.degraded["mirror detached (source not in this document)"],
    ).toBe(1);
    const copy = forest[0]!;
    expect(copy.mirrorOfOpmlId).toBeNull();
    expect(copy.children.map((c) => c.text)).toEqual(["kid"]);
  });

  it("imports _task and counts unknown attributes", () => {
    const { forest, report } = run(
      doc('<outline text="t" _task="true" _uuid="x" />'),
    );
    expect(forest[0]!.isTask).toBe(true);
    expect(report.unknownAttributes).toEqual({ _uuid: 1 });
  });
});

describe("failure modes (never a partial plan)", () => {
  it("fails a truncated document with line/column", () => {
    const error = runFail(sampleOpml.slice(0, 200));
    expect(error).toBeInstanceOf(OpmlParseError);
    const parseError = error as OpmlParseError;
    expect(parseError.line).toBeGreaterThan(0);
    expect(parseError.column).toBeGreaterThan(0);
  });

  it("rejects the entity bomb", () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
      '<opml version="2.0"><body><outline text="&lol2;" /></body></opml>';
    expect(runFail(bomb)).toBeInstanceOf(OpmlParseError);
  });

  it("guards raw size BEFORE parsing", () => {
    const error = runFail(sampleOpml, { maxLength: 100 });
    expect(error).toBeInstanceOf(OpmlTooLarge);
  });

  it("rejects a well-formed non-OPML document", () => {
    const error = runFail("<foo><bar /></foo>");
    expect(error).toBeInstanceOf(OpmlParseError);
    expect((error as OpmlParseError).line).toBeNull();
  });
});

// --- Planner ---------------------------------------------------------------------

const plain = (
  text: string,
  children: OpmlImportNode[] = [],
): OpmlImportNode => ({
  text,
  completed: false,
  isTask: false,
  opmlId: null,
  mirrorOfOpmlId: null,
  children,
});

const counterId = (): (() => string) => {
  let n = 0;
  return () => `id${++n}`;
};

const insertedNodes = (ops: ChangeOp[]): Node[] =>
  ops.flatMap((op) => (op.op === "insert" ? [op.value] : []));

describe("planOpmlImport", () => {
  it("wires sibling chains correct-by-construction as ONE batch", () => {
    const forest = [plain("A", [plain("B"), plain("C")]), plain("D")];
    const plan = planOpmlImport(forest, {
      parentId: "p",
      firstPrev: "anchor",
      timestamp: 42,
      newId: counterId(),
      maxNodes: 100,
    });
    if (plan instanceof OpmlEmpty || plan instanceof OpmlImportTooLarge) {
      throw new Error("expected a plan");
    }
    expect(plan.count).toBe(4);
    const nodes = insertedNodes(plan.ops);
    expect(nodes.map((n) => [n.text, n.parentId, n.prevSiblingId])).toEqual([
      ["A", "p", "anchor"],
      ["B", "id1", null],
      ["C", "id1", "id2"],
      ["D", "p", "id1"],
    ]);
    expect(plan.rootIds).toEqual(["id1", "id4"]);
    for (const n of nodes) {
      expect(n.createdAt).toBe(42);
      expect(n.updatedAt).toBe(42);
    }
  });

  it("carries completed / isTask / origin onto the inserted nodes", () => {
    const forest: OpmlImportNode[] = [
      { ...plain("done"), completed: true, isTask: true },
    ];
    const plan = planOpmlImport(forest, {
      parentId: null,
      firstPrev: null,
      origin: "test-agent",
      timestamp: 1,
      newId: counterId(),
      maxNodes: 10,
    });
    if (plan instanceof OpmlEmpty || plan instanceof OpmlImportTooLarge) {
      throw new Error("expected a plan");
    }
    const [node] = insertedNodes(plan.ops);
    expect(node!.completed).toBe(true);
    expect(node!.isTask).toBe(true);
    expect(node!.origin).toBe("test-agent");
  });

  it("resolves a mirror to the minted id of its source, even forward-referenced", () => {
    const mirror: OpmlImportNode = {
      ...plain("source"),
      mirrorOfOpmlId: "src1",
    };
    const source: OpmlImportNode = { ...plain("source"), opmlId: "src1" };
    const plan = planOpmlImport([mirror, source], {
      parentId: null,
      firstPrev: null,
      timestamp: 1,
      newId: counterId(),
      maxNodes: 10,
    });
    if (plan instanceof OpmlEmpty || plan instanceof OpmlImportTooLarge) {
      throw new Error("expected a plan");
    }
    const nodes = insertedNodes(plan.ops);
    expect(nodes[0]!.mirrorOf).toBe("id2");
    expect(nodes[1]!.mirrorOf).toBeNull();
  });

  it("fails the WHOLE call over the ceiling — no partial plan", () => {
    const forest = [plain("A", [plain("B"), plain("C"), plain("D")])];
    const plan = planOpmlImport(forest, {
      parentId: null,
      firstPrev: null,
      timestamp: 1,
      newId: counterId(),
      maxNodes: 3,
    });
    expect(plan).toBeInstanceOf(OpmlImportTooLarge);
    expect((plan as OpmlImportTooLarge).count).toBe(4);
  });

  it("rejects an empty forest", () => {
    const plan = planOpmlImport([], {
      parentId: null,
      firstPrev: null,
      timestamp: 1,
      newId: counterId(),
      maxNodes: 10,
    });
    expect(plan).toBeInstanceOf(OpmlEmpty);
  });
});
