import { describe, expect, test } from "bun:test";

import { isLunoraOutlineEnabled } from "./lunora-mcp-store";

describe("isLunoraOutlineEnabled", () => {
  test("default ON when unset", () => {
    expect(isLunoraOutlineEnabled({})).toBe(true);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "" })).toBe(true);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "1" })).toBe(true);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "true" })).toBe(true);
  });

  test("explicit off values disable", () => {
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "0" })).toBe(false);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "false" })).toBe(false);
    expect(isLunoraOutlineEnabled({ LUNORA_OUTLINE: "off" })).toBe(false);
  });
});
