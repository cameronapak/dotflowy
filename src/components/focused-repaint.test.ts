import { expect, test } from "bun:test";

import { keepsFocusedDom } from "./focused-repaint";

test("a render the store has already moved past does not repaint", () => {
  // Recorded in CI: "K" rendered, then "e" was typed before that render's
  // effect ran. The repaint put "K" back and the rest of the word landed
  // before the "e".
  expect(
    keepsFocusedDom({
      rendered: "K",
      live: "Ke",
      echoed: undefined,
      heldDom: null,
    }),
  ).toBe(true);
});

test("stored text that is news to the DOM repaints", () => {
  // A slash insert or an undo writes the store; the DOM still shows "K".
  expect(
    keepsFocusedDom({
      rendered: "Kept",
      live: "Kept",
      echoed: "K",
      heldDom: null,
    }),
  ).toBe(false);
  // A node the store does not hold has no newer text to wait for.
  expect(
    keepsFocusedDom({
      rendered: "Kept",
      live: undefined,
      echoed: undefined,
      heldDom: null,
    }),
  ).toBe(false);
});

test("an echo of this editor's own text does not repaint", () => {
  expect(
    keepsFocusedDom({
      rendered: "Ke",
      live: "Ke",
      echoed: "Ke",
      heldDom: null,
    }),
  ).toBe(true);
});

test("a title holds text typed ahead of the stored prefix", () => {
  const title = { rendered: "Ke", live: "Ke", echoed: undefined };
  expect(keepsFocusedDom({ ...title, heldDom: "Keep" })).toBe(true);
  expect(keepsFocusedDom({ ...title, heldDom: "Other" })).toBe(false);
  expect(keepsFocusedDom({ ...title, heldDom: "Ke" })).toBe(false);
});
