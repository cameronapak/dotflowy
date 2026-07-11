import { describe, expect, test } from "bun:test";

import { CORE_FILTER_OPERATORS } from "./core-filter-operators";
import {
  buildFilterOperatorMap,
  buildFilterSuggestions,
  buildQueryFilter,
  caretToken,
  collectOperatorKeyInfos,
  type FilterOperator,
  parseFilterQuery,
  tokenizeQuery,
} from "./filter-query";
import { buildTreeIndex, makeNode, type Node } from "./tree";

const index = (nodes: Node[]) => buildTreeIndex(nodes);
const never = () => false;

// A representative operator map: the real core kind operators plus inline twins
// of the plugin operators (todos/links/highlight/provenance), so the eval tests
// stay pure and never import a plugin's React module.
const ops = buildFilterOperatorMap([
  ...CORE_FILTER_OPERATORS,
  {
    key: "is",
    values: ["complete"],
    description: "",
    predicate: (n) => n.completed,
  },
  {
    key: "is",
    values: ["agent"],
    description: "",
    predicate: (n) => n.origin != null,
  },
  {
    key: "has",
    values: ["link"],
    description: "",
    predicate: (n) => /\[[^\]]*\]\([^)]*\)/.test(n.text),
  },
  {
    key: "highlight",
    values: ["red", "blue"],
    bare: true,
    description: "",
    predicate: (n, _i, v) => {
      if (!n.text.includes("==")) return false;
      if (v === null) return true;
      // Bare `==x==` counts as blue; `==🔴x==` as red.
      return v === "red" ? n.text.includes("==🔴") : !n.text.includes("==🔴");
    },
  },
]);

describe("tokenizeQuery", () => {
  test("splits on whitespace, drops empties", () => {
    expect(tokenizeQuery(undefined)).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
    expect(tokenizeQuery("#a  is:todo   word")).toEqual([
      "#a",
      "is:todo",
      "word",
    ]);
  });

  test("keeps a quoted phrase (with its spaces) as one token", () => {
    expect(tokenizeQuery('a "b c" d')).toEqual(["a", '"b c"', "d"]);
    expect(tokenizeQuery('-"b c"')).toEqual(['-"b c"']);
  });

  test("an unterminated quote runs to end of string", () => {
    expect(tokenizeQuery('a "b c')).toEqual(["a", '"b c']);
  });
});

describe("parseFilterQuery", () => {
  test("empty input yields no groups (no filter)", () => {
    expect(parseFilterQuery(undefined).groups).toEqual([]);
    expect(parseFilterQuery("   ").groups).toEqual([]);
  });

  test("spaces are AND: one group per term", () => {
    const q = parseFilterQuery("#a word");
    expect(q.groups).toHaveLength(2);
    expect(q.groups[0]!.terms[0]).toMatchObject({ type: "tag", tag: "#a" });
    expect(q.groups[1]!.terms[0]).toMatchObject({
      type: "text",
      value: "word",
    });
  });

  test("uppercase OR binds adjacent terms into one group", () => {
    const q = parseFilterQuery("#a OR #b #c");
    expect(q.groups).toHaveLength(2);
    expect(q.groups[0]!.terms).toHaveLength(2); // #a OR #b
    expect(q.groups[1]!.terms).toHaveLength(1); // #c
  });

  test("a chain of ORs stays one group", () => {
    const q = parseFilterQuery("a OR b OR c");
    expect(q.groups).toHaveLength(1);
    expect(q.groups[0]!.terms).toHaveLength(3);
  });

  test("a dangling OR degrades to literal text", () => {
    expect(parseFilterQuery("OR").groups[0]!.terms[0]).toMatchObject({
      type: "text",
      value: "OR",
    });
    // trailing OR with nothing after it
    const q = parseFilterQuery("a OR");
    expect(q.groups).toHaveLength(2);
    expect(q.groups[1]!.terms[0]).toMatchObject({ type: "text", value: "OR" });
  });

  test("leading - negates any term shape", () => {
    const q = parseFilterQuery('-word -#a -is:todo -"a b"');
    expect(q.groups.map((g) => g.terms[0]!.negated)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("a quoted phrase is literal text, escaping OR and operators", () => {
    const q = parseFilterQuery('"is:todo OR x"');
    expect(q.groups).toHaveLength(1);
    expect(q.groups[0]!.terms[0]).toMatchObject({
      type: "text",
      value: "is:todo OR x",
    });
  });

  test("key:value parses to an operator term with lowercased value", () => {
    const q = parseFilterQuery("is:TODO");
    expect(q.groups[0]!.terms[0]).toMatchObject({
      type: "operator",
      key: "is",
      value: "todo",
      raw: "is:TODO",
    });
  });

  test("bare key: has a null value", () => {
    expect(parseFilterQuery("highlight:").groups[0]!.terms[0]).toMatchObject({
      type: "operator",
      key: "highlight",
      value: null,
    });
  });

  test("a bare # is not a tag (falls to text)", () => {
    expect(parseFilterQuery("#").groups[0]!.terms[0]).toMatchObject({
      type: "text",
      value: "#",
    });
  });
});

describe("buildFilterOperatorMap", () => {
  test("shared key, different values is allowed", () => {
    expect(() =>
      buildFilterOperatorMap([
        { key: "is", values: ["todo"], description: "", predicate: () => true },
        {
          key: "is",
          values: ["complete"],
          description: "",
          predicate: () => true,
        },
      ]),
    ).not.toThrow();
  });

  test("a duplicate (key, value) pair throws at load", () => {
    expect(() =>
      buildFilterOperatorMap([
        { key: "is", values: ["todo"], description: "", predicate: () => true },
        { key: "is", values: ["todo"], description: "", predicate: () => true },
      ]),
    ).toThrow(/duplicate operator claim/);
  });

  test("a duplicate bare claim throws", () => {
    const bare: FilterOperator = {
      key: "highlight",
      bare: true,
      description: "",
      predicate: () => true,
    };
    expect(() => buildFilterOperatorMap([bare, bare])).toThrow(/highlight:/);
  });
});

// The operators the autocomplete tests read: core kind values + inline twins of
// the plugin operators (so `is` folds three owners' values, `highlight` paints).
const AUTOCOMPLETE_OPS: FilterOperator[] = [
  ...CORE_FILTER_OPERATORS,
  { key: "is", values: ["complete"], description: "", predicate: () => true },
  { key: "is", values: ["agent"], description: "", predicate: () => true },
  {
    key: "has",
    values: ["link"],
    description: "Has a link",
    predicate: () => true,
  },
  {
    key: "highlight",
    values: ["red", "blue"],
    bare: true,
    swatch: true,
    description: "Highlighted",
    predicate: () => true,
  },
];

describe("collectOperatorKeyInfos", () => {
  const infos = collectOperatorKeyInfos(AUTOCOMPLETE_OPS);
  const is = infos.find((i) => i.key === "is")!;

  test("folds shared-key operators into one entry (union of values)", () => {
    expect(infos.map((i) => i.key)).toEqual(["is", "has", "highlight"]);
    expect(is.values).toEqual([
      "todo",
      "bullet",
      "paragraph",
      "mirror",
      "complete",
      "agent",
    ]);
  });

  test("description is the FIRST-registered operator's (core for `is`)", () => {
    expect(is.description).toBe(CORE_FILTER_OPERATORS[0]!.description);
  });

  test("bare + swatch flags fold across a key", () => {
    const hl = infos.find((i) => i.key === "highlight")!;
    expect(hl.bare).toBe(true);
    expect(hl.swatch).toBe(true);
    expect(is.bare).toBe(false);
    expect(is.swatch).toBe(false);
  });
});

describe("caretToken", () => {
  test("returns the whitespace-delimited chunk containing the caret", () => {
    expect(caretToken("is:todo #work", 3)).toEqual({
      token: "is:todo",
      start: 0,
      end: 7,
    });
    // caret inside the second token
    expect(caretToken("is:todo #work", 11)).toMatchObject({ token: "#work" });
  });

  test("an empty token when the caret sits between spaces", () => {
    expect(caretToken("a  b", 2)).toEqual({ token: "", start: 2, end: 2 });
  });

  test("clamps an out-of-range caret", () => {
    expect(caretToken("abc", 99)).toEqual({ token: "abc", start: 0, end: 3 });
  });
});

describe("buildFilterSuggestions", () => {
  const infos = collectOperatorKeyInfos(AUTOCOMPLETE_OPS);
  const tags = ["#home", "#work", "#workflow"];
  const build = (token: string) => buildFilterSuggestions(token, infos, tags);

  test("empty token = the cheat sheet (keys + a #tag row)", () => {
    const s = build("");
    expect(s.map((r) => r.label)).toEqual([
      "is:",
      "has:",
      "highlight:",
      "#tag",
    ]);
    // A cheat-sheet key inserts `key:` with NO trailing space (chains to values).
    expect(s[0]!.insert).toBe("is:");
    expect(s.at(-1)!.insert).toBe("#");
  });

  test("a partial key filters the cheat sheet by prefix (no #tag row)", () => {
    expect(build("hi").map((r) => r.label)).toEqual(["highlight:"]);
  });

  test("`key:` lists that key's values (complete term + trailing space)", () => {
    const s = build("is:");
    expect(s.map((r) => r.label)).toEqual([
      "is:todo",
      "is:bullet",
      "is:paragraph",
      "is:mirror",
      "is:complete",
      "is:agent",
    ]);
    expect(s[0]!.insert).toBe("is:todo ");
  });

  test("`key:partial` filters values by prefix", () => {
    expect(build("is:co").map((r) => r.label)).toEqual(["is:complete"]);
  });

  test("a bare-owning key offers its bare form + swatches", () => {
    const s = build("highlight:");
    expect(s[0]!.label).toBe("highlight:"); // the bare (any) form
    expect(s[0]!.insert).toBe("highlight: ");
    const red = s.find((r) => r.label === "highlight:red")!;
    expect(red.swatch).toBe("red");
  });

  test("`#partial` = tag corpus by case-insensitive substring", () => {
    const s = build("#work");
    expect(s.map((r) => r.label)).toEqual(["#work", "#workflow"]);
    expect(s[0]!.display).toBe("tag");
    expect(s[0]!.tag).toBe("work");
    expect(s[0]!.insert).toBe("#work ");
  });

  test("a leading `-` is transparent but rides the insert", () => {
    expect(build("-is:").map((r) => r.insert)).toContain("-is:todo ");
    expect(build("-#wor")[0]!.insert).toBe("-#work ");
  });

  test("an unknown key and a quoted phrase yield nothing", () => {
    expect(build("nope:x")).toEqual([]);
    expect(build('"phrase')).toEqual([]);
  });
});

describe("buildQueryFilter", () => {
  // r -> c -> g(#x, "match")
  const r = makeNode({ id: "r", text: "root" });
  const c = makeNode({ id: "c", parentId: "r", text: "middle" });
  const g = makeNode({ id: "g", parentId: "c", text: "#x match" });
  const base = index([r, c, g]);

  test("no query = no filter (null)", () => {
    expect(buildQueryFilter(base, "r", "", never, ops)).toBeNull();
    expect(buildQueryFilter(base, "r", undefined, never, ops)).toBeNull();
  });

  test("a #tag match pulls in ancestors (dimmed) but not the root", () => {
    const f = buildQueryFilter(base, "r", "#x", never, ops)!;
    expect(f.matchIds).toEqual(new Set(["g"]));
    expect(f.visibleIds).toEqual(new Set(["g", "c"]));
    expect(f.emptyMessage).toBeUndefined();
  });

  test("free text is a case-insensitive substring over flattened text", () => {
    const f = buildQueryFilter(base, "r", "MATCH", never, ops)!;
    expect(f.matchIds).toEqual(new Set(["g"]));
  });

  test("free text matches a folded link's label, not its url", () => {
    const l = makeNode({
      id: "l",
      parentId: "r",
      text: "see [Docs](http://x)",
    });
    const tree = index([r, l]);
    expect(buildQueryFilter(tree, "r", "docs", never, ops)!.matchIds).toEqual(
      new Set(["l"]),
    );
    // the url is not part of the reading text
    expect(buildQueryFilter(tree, "r", "http", never, ops)!.matchIds.size).toBe(
      0,
    );
  });

  test("no matches sets emptyMessage", () => {
    const f = buildQueryFilter(base, "r", "#nope", never, ops)!;
    expect(f.matchIds.size).toBe(0);
    expect(f.emptyMessage).toBe('No matches for "#nope" here.');
  });

  test("isHidden takes a subtree (and its matches) with it", () => {
    const hideC = (n: Node) => n.id === "c";
    const f = buildQueryFilter(base, "r", "#x", hideC, ops)!;
    expect(f.matchIds.size).toBe(0);
  });

  describe("node-kind operators (ADR 0045 tie-break)", () => {
    const todo = makeNode({ id: "t", parentId: "r", text: "t", isTask: true });
    const bullet = makeNode({ id: "b", parentId: "r", text: "b" });
    const para = makeNode({
      id: "p",
      parentId: "r",
      text: "p",
      kind: "paragraph",
    });
    // Illegal pair (stale client): kind wins, so this is a paragraph, not a todo.
    const both = makeNode({
      id: "x",
      parentId: "r",
      text: "x",
      isTask: true,
      kind: "paragraph",
    });
    const tree = index([r, todo, bullet, para, both]);

    test("is:todo excludes paragraphs even with isTask true", () => {
      expect(
        buildQueryFilter(tree, "r", "is:todo", never, ops)!.matchIds,
      ).toEqual(new Set(["t"]));
    });
    test("is:bullet is neither task nor paragraph", () => {
      expect(
        buildQueryFilter(tree, "r", "is:bullet", never, ops)!.matchIds,
      ).toEqual(new Set(["b"]));
    });
    test("is:paragraph wins the tie-break", () => {
      expect(
        buildQueryFilter(tree, "r", "is:paragraph", never, ops)!.matchIds,
      ).toEqual(new Set(["p", "x"]));
    });
  });

  test("is:mirror, is:complete, is:agent, has:link, highlight predicates", () => {
    const mir = makeNode({ id: "m", parentId: "r", text: "m", mirrorOf: "s" });
    const done = makeNode({
      id: "d",
      parentId: "r",
      text: "d",
      completed: true,
    });
    const agent = makeNode({
      id: "a",
      parentId: "r",
      text: "a",
      origin: "Claude",
    });
    const link = makeNode({ id: "k", parentId: "r", text: "[x](http://y)" });
    const hl = makeNode({ id: "h", parentId: "r", text: "==note==" });
    const red = makeNode({ id: "rd", parentId: "r", text: "==🔴hot==" });
    const tree = index([r, mir, done, agent, link, hl, red]);
    const ids = (q: string) =>
      buildQueryFilter(tree, "r", q, never, ops)!.matchIds;
    expect(ids("is:mirror")).toEqual(new Set(["m"]));
    expect(ids("is:complete")).toEqual(new Set(["d"]));
    expect(ids("is:agent")).toEqual(new Set(["a"]));
    expect(ids("has:link")).toEqual(new Set(["k"]));
    expect(ids("highlight:")).toEqual(new Set(["h", "rd"])); // any highlight
    expect(ids("highlight:red")).toEqual(new Set(["rd"]));
    expect(ids("highlight:blue")).toEqual(new Set(["h"])); // bare run = blue
  });

  test("negation, AND, and OR combine as expected", () => {
    const a = makeNode({ id: "a", parentId: "r", text: "alpha", isTask: true });
    const b = makeNode({ id: "b", parentId: "r", text: "bravo" });
    const cc = makeNode({ id: "cc", parentId: "r", text: "alpha bravo" });
    const tree = index([r, a, b, cc]);
    const ids = (q: string) =>
      buildQueryFilter(tree, "r", q, never, ops)!.matchIds;
    // AND: contains "alpha" AND is a todo
    expect(ids("alpha is:todo")).toEqual(new Set(["a"]));
    // NOT: contains "alpha" but not a todo
    expect(ids("alpha -is:todo")).toEqual(new Set(["cc"]));
    // OR: alpha OR bravo -> all three
    expect(ids("alpha OR bravo")).toEqual(new Set(["a", "b", "cc"]));
  });

  test("an unknown operator degrades to a free-text match on its raw source", () => {
    const n = makeNode({
      id: "n",
      parentId: "r",
      text: "talk about is:foo now",
    });
    const tree = index([r, n]);
    // is:foo isn't registered, so it matches the literal substring "is:foo"
    expect(buildQueryFilter(tree, "r", "is:foo", never, ops)!.matchIds).toEqual(
      new Set(["n"]),
    );
  });

  describe("ADR 0047 §8: a match reveals its subtree", () => {
    // r -> c -> g(match) -> d -> e
    const g2 = makeNode({ id: "g", parentId: "c", text: "#x" });
    const d = makeNode({ id: "d", parentId: "g", text: "child" });
    const e = makeNode({ id: "e", parentId: "d", text: "grandchild" });

    test("descendants render undimmed; ancestors stay dimmed context", () => {
      const tree = index([r, c, g2, d, e]);
      const f = buildQueryFilter(tree, "r", "#x", never, ops)!;
      // visible: match + ancestors (c) + revealed descendants (d, e)
      expect(f.visibleIds).toEqual(new Set(["c", "g", "d", "e"]));
      // undimmed: match + its descendants; c (ancestor) is NOT in matchIds
      expect(f.matchIds).toEqual(new Set(["g", "d", "e"]));
      expect(f.matchIds.has("c")).toBe(false);
    });

    test("a collapsed match hides its descendants (collapse respected)", () => {
      const gCollapsed = makeNode({
        id: "g",
        parentId: "c",
        text: "#x",
        collapsed: true,
      });
      const tree = index([r, c, gCollapsed, d, e]);
      const f = buildQueryFilter(tree, "r", "#x", never, ops)!;
      expect(f.visibleIds).toEqual(new Set(["c", "g"]));
      expect(f.matchIds).toEqual(new Set(["g"]));
    });

    test("a match deep inside a collapsed subtree is still revealed", () => {
      // g collapsed, but e independently matches -> revealed with its ancestors
      const gCollapsed = makeNode({
        id: "g",
        parentId: "c",
        text: "plain",
        collapsed: true,
      });
      const d2 = makeNode({ id: "d", parentId: "g", text: "plain" });
      const eMatch = makeNode({ id: "e", parentId: "d", text: "#x deep" });
      const tree = index([r, c, gCollapsed, d2, eMatch]);
      const f = buildQueryFilter(tree, "r", "#x", never, ops)!;
      expect(f.matchIds).toEqual(new Set(["e"]));
      expect(f.visibleIds).toEqual(new Set(["c", "g", "d", "e"]));
    });
  });
});
