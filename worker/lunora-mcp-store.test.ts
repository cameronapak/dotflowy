import { describe, expect, test } from "bun:test";

import {
  decodeClaimDailyResult,
  decodeDailyClaimValue,
  decodeDailyIndexRows,
  decodeMcpNodeList,
  decodeShardRpcEnvelope,
  isLunoraOutlineEnabledForUser,
  isLunoraOutlineEnabledSync,
  parseLunoraBetaPref,
  resolveLunoraOutlineEnvForce,
} from "./lunora-mcp-store";

describe("resolveLunoraOutlineEnvForce", () => {
  test("unset returns null", () => {
    expect(resolveLunoraOutlineEnvForce({})).toBe(null);
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "" })).toBe(null);
  });

  test("explicit on values force ON", () => {
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "1" })).toBe(true);
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "true" })).toBe(true);
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "on" })).toBe(true);
  });

  test("explicit off values force OFF", () => {
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "0" })).toBe(false);
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "false" })).toBe(
      false,
    );
    expect(resolveLunoraOutlineEnvForce({ LUNORA_OUTLINE: "off" })).toBe(false);
  });
});

describe("parseLunoraBetaPref", () => {
  test("missing or disabled rows → false", () => {
    expect(parseLunoraBetaPref([])).toBe(false);
    expect(parseLunoraBetaPref([{ id: "lunora-beta", enabled: false }])).toBe(
      false,
    );
    expect(parseLunoraBetaPref([{ id: "other", enabled: true }])).toBe(false);
  });

  test("enabled row → true", () => {
    expect(parseLunoraBetaPref([{ id: "lunora-beta", enabled: true }])).toBe(
      true,
    );
  });
});

describe("isLunoraOutlineEnabledSync", () => {
  test("unset env → false (classic default)", () => {
    expect(isLunoraOutlineEnabledSync({})).toBe(false);
  });

  test("respects env force", () => {
    expect(isLunoraOutlineEnabledSync({ LUNORA_OUTLINE: "1" })).toBe(true);
    expect(isLunoraOutlineEnabledSync({ LUNORA_OUTLINE: "0" })).toBe(false);
  });
});

describe("isLunoraOutlineEnabledForUser", () => {
  test("env force on skips preference lookup", async () => {
    let called = false;
    expect(
      await isLunoraOutlineEnabledForUser({ LUNORA_OUTLINE: "1" }, async () => {
        called = true;
        return [];
      }),
    ).toBe(true);
    expect(called).toBe(false);
  });

  test("unset env uses account pref", async () => {
    expect(
      await isLunoraOutlineEnabledForUser({}, async () => [
        { id: "lunora-beta", enabled: true },
      ]),
    ).toBe(true);
    expect(await isLunoraOutlineEnabledForUser({}, async () => [])).toBe(false);
  });
});

describe("shard RPC decode (Worker→Lunora trust boundary)", () => {
  test("decodeShardRpcEnvelope accepts ok + error shapes", () => {
    expect(decodeShardRpcEnvelope({ result: 1 })).toEqual({ result: 1 });
    expect(decodeShardRpcEnvelope({ error: { message: "nope" } })).toEqual({
      error: { message: "nope" },
    });
  });

  test("decodeShardRpcEnvelope rejects garbage", () => {
    expect(() => decodeShardRpcEnvelope("nope")).toThrow();
  });

  test("decodeMcpNodeList validates wire nodes", () => {
    const node = {
      id: "n1",
      parentId: null,
      prevSiblingId: null,
      text: "hi",
      isTask: false,
      completed: false,
      collapsed: false,
      bookmarkedAt: null,
      mirrorOf: null,
      createdAt: 1,
      updatedAt: 1,
      origin: null,
      kind: null,
    };
    expect(decodeMcpNodeList([node])).toEqual([node]);
    expect(() => decodeMcpNodeList([{ id: "x" }])).toThrow();
  });

  test("decodeDailyIndexRows + claim helpers", () => {
    expect(decodeDailyIndexRows([{ key: "k", nodeId: "n" }])).toEqual([
      { key: "k", nodeId: "n" },
    ]);
    expect(decodeClaimDailyResult({ nodeId: "n" })).toEqual({ nodeId: "n" });
    expect(decodeDailyClaimValue({ nodeId: "n" })).toEqual({ nodeId: "n" });
    expect(() => decodeDailyClaimValue({})).toThrow();
  });
});
