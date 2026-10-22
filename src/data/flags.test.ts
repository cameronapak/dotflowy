import { expect, test } from "bun:test";

import { isMirrorsEnabled } from "./flags";

test("mirrors default on when no rollback preference is saved", () => {
  // SAFETY: flags only reads localStorage.getItem; restore any prior test window.
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = {
    localStorage: { getItem: () => null },
  };
  try {
    expect(isMirrorsEnabled()).toBe(true);
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
});
