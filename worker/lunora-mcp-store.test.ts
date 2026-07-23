import { describe, expect, test } from "bun:test";

import { isLunoraOutlineEnabled } from "./lunora-mcp-store";

describe("isLunoraOutlineEnabled", () => {
  test("default OFF", () => {
    expect(isLunoraOutlineEnabled({})).toBe(false);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "" })).toBe(false);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "0" })).toBe(false);
  });

  test("on for 1 or true", () => {
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "1" })).toBe(true);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "true" })).toBe(true);
  });
});
