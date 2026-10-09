import { expect, test } from "bun:test";

import { tagColorsCss, type TagColorRow } from "./tag-colors";

const row = (tag: string, color: string): TagColorRow => ({ tag, color });

test("tagColorsCss emits one keyed rule per valid colored tag", () => {
  expect(tagColorsCss([])).toBe("");
  const css = tagColorsCss([row("work", "blue")]);
  expect(css.split("\n")).toHaveLength(1);
  expect(css).toContain(
    '[data-tag="work" i][data-tag]{background:var(--tag-blue)',
  );
  // Hyphen, underscore, and unicode tag names are allowed.
  expect(tagColorsCss([row("work-q3", "red")])).toContain(
    '[data-tag="work-q3" i]',
  );
  expect(tagColorsCss([row("важно", "green")])).toContain(
    '[data-tag="важно" i]',
  );
});

test("tagColorsCss skips an unknown color and an unsafe tag name (CSS-injection guard)", () => {
  expect(tagColorsCss([row("work", "rainbow")])).toBe("");
  // Quotes, brackets, braces, and spaces fail the /^[\p{L}\p{N}_-]+$/u guard.
  expect(tagColorsCss([row('work"]{}', "blue")])).toBe("");
  expect(tagColorsCss([row("has space", "blue")])).toBe("");
  // A mixed batch emits only the safe rows.
  const css = tagColorsCss([
    row("ok", "teal"),
    row('bad"name', "teal"),
    row("ok2", "notacolor"),
  ]);
  expect(css).toContain('[data-tag="ok" i]');
  expect(css).not.toContain("bad");
  expect(css).not.toContain("ok2");
});
