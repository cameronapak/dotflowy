import type { ShardNamespaceLike } from "lunorash/runtime";

import { describe, expect, test } from "vitest";

import {
  createLunoraOutlineStore,
  decodeClaimDailyResult,
  decodeDailyClaimValue,
  decodeDailyIndexRows,
  decodeMcpNodeList,
  isLunoraOutlineEnabledForUser,
  isLunoraOutlineEnabledSync,
  parseLunoraBetaPref,
  resolveLunoraOutlineEnvForce,
  wipeLunoraUserShard,
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

  test("env force off skips preference lookup", async () => {
    let called = false;
    expect(
      await isLunoraOutlineEnabledForUser({ LUNORA_OUTLINE: "0" }, async () => {
        called = true;
        return [{ id: "lunora-beta", enabled: true }];
      }),
    ).toBe(false);
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

  test("a failed preference read falls back to classic, not a thrown /mcp", async () => {
    expect(
      await isLunoraOutlineEnabledForUser({}, async () => {
        throw new Error("DO unavailable");
      }),
    ).toBe(false);
  });
});

describe("shard payload decode (Worker→Lunora trust boundary)", () => {
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
    expect(decodeClaimDailyResult({ nodeId: "n", won: true })).toEqual({
      nodeId: "n",
      won: true,
    });
    expect(decodeDailyClaimValue({ nodeId: "n" })).toEqual({ nodeId: "n" });
    expect(() => decodeDailyClaimValue({})).toThrow();
  });
});

describe("shard client identity", () => {
  test("normal calls run user-as; wipe runs pure system", async () => {
    const identities: Array<{ system: string | null; userId: string | null }> =
      [];
    const stub = {
      fetch: async (request: Request) => {
        identities.push({
          system: request.headers.get("x-lunora-system"),
          userId: request.headers.get("x-lunora-userid"),
        });
        // SAFETY: this stub only receives requests the shard client serializes, each carrying a functionPath string.
        const body = (await request.json()) as { functionPath: string };
        return Response.json({
          result: body.functionPath === "mcp:listNodes" ? [] : { deleted: 0 },
        });
      },
    };
    const shard: ShardNamespaceLike = {
      get: () => stub,
      getByName: () => stub,
      idFromName: (name) => name,
    };

    await createLunoraOutlineStore({ SHARD: shard }, "u1").getNodes();
    await wipeLunoraUserShard({ SHARD: shard }, "u1");

    expect(identities[0]).toEqual({ system: "1", userId: "u1" });
    expect(identities[1]).toEqual({ system: "1", userId: null });
  });
});
