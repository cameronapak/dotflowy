import { expect, test } from "bun:test";

import type { ElNode, TokenView } from "../types";

import { foldedLinkEl, LINK_PARTS, revealedLinkEl } from "./render";

function render(tok: string, revealed = false): ElNode {
  const [, label = "", url = ""] = LINK_PARTS.exec(tok) ?? [];
  const view: TokenView = {
    revealOffset: revealed ? 1 : null,
    start: 0,
    end: tok.length,
    renderInline: (text) => [text],
  };
  // SAFETY: both renders return an element node, never a bare string
  return (
    revealed ? revealedLinkEl(label, url, view) : foldedLinkEl(label, url, tok)
  ) as ElNode;
}

// Every descriptor in the tree carrying `tag: "a"`.
function anchors(el: ElNode): ElNode[] {
  const found: ElNode[] = [];
  JSON.stringify(el, (_key, value: ElNode) => {
    if (value?.tag === "a") found.push(value);
    return value;
  });
  return found;
}

function hrefs(el: ElNode): string[] {
  return JSON.stringify(el).match(/"href":"[^"]*"/g) ?? [];
}

const unsafe = ["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))"];

test.each(unsafe)("%s folds to an inert anchor with no href", (tok) => {
  const el = render(tok);
  const [a] = anchors(el);
  expect(a?.attrs?.["href"]).toBeUndefined();
  expect(a?.attrs?.["data-unsafe-link"]).toBe(true);
  expect(hrefs(el)).toEqual([]);
  // Still one source atom, so caret math and the edit pencil keep working.
  expect(el.attrs?.["data-src"]).toBe(tok);
});

test.each(unsafe)("%s revealed renders no href", (tok) => {
  expect(hrefs(render(tok, true))).toEqual([]);
});

test("an https link keeps its href", () => {
  const [a] = anchors(render("[x](https://e.com)"));
  expect(a?.attrs?.["href"]).toBe("https://e.com");
  expect(a?.attrs?.["data-unsafe-link"]).toBe(false);
});
