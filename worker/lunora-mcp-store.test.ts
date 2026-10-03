import type { ShardNamespaceLike } from "lunorash/runtime";

import { describe, expect, test } from "bun:test";

import {
  createLunoraRetirementClient,
  wipeLunoraUserShard,
} from "./lunora-mcp-store";

describe("shard client identity", () => {
  test("malformed private archive replies expose only a constant schema error", async () => {
    const stub = {
      fetch: async () =>
        Response.json({
          result: {
            version: 1,
            userId: "u1",
            exportedAt: 1,
            snapshot: { nodes: [{ text: "PRIVATE_ARCHIVE_CONTENT" }] },
            raw: {},
          },
        }),
    };
    const shard: ShardNamespaceLike = {
      get: () => stub,
      getByName: () => stub,
      idFromName: (name) => name,
    };
    await expect(
      createLunoraRetirementClient(
        { SHARD: shard },
        "u1",
      ).freezeAndExportArchive("migration", 1),
    ).rejects.toThrow(/^experimental retirement archive schema rejected$/);
  });

  test("retirement and wipe calls use pure system identity", async () => {
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
          result:
            body.functionPath === "mcp:inspectRetirement"
              ? { retirement: null, snapshot: {} }
              : { deleted: 0 },
        });
      },
    };
    const shard: ShardNamespaceLike = {
      get: () => stub,
      getByName: () => stub,
      idFromName: (name) => name,
    };

    await createLunoraRetirementClient({ SHARD: shard }, "u1").inspect();
    await wipeLunoraUserShard({ SHARD: shard }, "u1");

    expect(identities[0]).toEqual({ system: "1", userId: null });
    expect(identities[1]).toEqual({ system: "1", userId: null });
  });
});
