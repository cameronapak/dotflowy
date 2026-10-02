import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import { build } from "esbuild";
import { Miniflare, type WebSocket } from "miniflare";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Node, ServerMessage } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "../worker/backup";
import type { LunoraRetirementSnapshot } from "../worker/lunora-retirement";
import type { RetirementRecord } from "../worker/lunora-retirement-service";
import type { Input } from "./retirement-worker";

import { ServerMessageSchema } from "../src/data/wire-schema";

// Real local Workerd storage, no production credentials or remote bindings.
test.describe.configure({ mode: "serial" });
let mf: Miniflare;
let directory: string;

type Inspection = {
  classic: OutlineSnapshot;
  status: { frozenBy: string | null; appliedMigrationId: string | null };
  lunora: {
    retirement: { status: string } | null;
    snapshot: LunoraRetirementSnapshot;
  };
  record: RetirementRecord;
};

function node(
  text: string,
  parentId: string | null = null,
  prevSiblingId: string | null = null,
): Node {
  return {
    id: randomUUID(),
    parentId,
    prevSiblingId,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 2,
    origin: null,
    kind: null,
  };
}

async function command<A>(
  path: string,
  userId: string,
  input: Omit<Input, "userId"> = {},
): Promise<A> {
  const response = await mf.dispatchFetch(`http://fixture${path}`, {
    method: "POST",
    body: JSON.stringify({ userId, ...input }),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  // SAFETY: each caller names the response type of the matching test-only handler.
  return result as A;
}

async function seed() {
  const userId = randomUUID();
  const classicNodes = [node("classic before migration")];
  const root = node("Lunora root #work");
  const child = node("Lunora child", root.id);
  const sibling = node("Lunora sibling", null, root.id);
  const lunoraNodes = [root, child, sibling];
  await command("/seed", userId, { classicNodes, lunoraNodes });
  return { userId, classicNodes, lunoraNodes };
}

async function connect(userId: string) {
  const response = await mf.dispatchFetch(
    `http://fixture/sync?userId=${userId}`,
    { headers: { Upgrade: "websocket" } },
  );
  const ws = response.webSocket;
  if (!ws) throw new Error("classic WebSocket upgrade failed");
  ws.accept();
  return ws;
}

function frame(ws: WebSocket, since: number | null): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      (event) => {
        try {
          resolve(
            Schema.decodeUnknownSync(ServerMessageSchema)(
              JSON.parse(String(event.data)),
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
    ws.addEventListener("error", reject, { once: true });
    ws.send(JSON.stringify({ type: "hello", since }));
  });
}

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dotflowy-retirement-"));
  const scriptPath = join(directory, "worker.mjs");
  await build({
    entryPoints: ["e2e/retirement-worker.ts"],
    outfile: scriptPath,
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:*", "node:*"],
    target: "es2022",
  });
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "retirement-test",
          compatibilityDate: "2026-06-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: directory,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: await readFile(scriptPath),
              },
            },
          },
          env: {
            USER_OUTLINE: {
              type: "durable-object",
              worker: "retirement-test",
              exportName: "UserOutlineDO",
            },
            SHARD: {
              type: "durable-object",
              worker: "retirement-test",
              exportName: "ShardDO",
            },
            DB: { type: "d1", id: "retirement-db" },
            BACKUPS: { type: "r2", name: "retirement-backups" },
          },
          exports: {
            UserOutlineDO: { type: "durable-object", storage: "sqlite" },
            ShardDO: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  for (const migration of [
    "0010_lunora_retirement.sql",
    "0011_lunora_retirement_operation_claim.sql",
  ]) {
    const sql = await readFile(`migrations/${migration}`, "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").replaceAll("\n", " "));
  }
});

test.afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("production shard shapes deliver outline snapshots and the live retirement signal", async () => {
  const { userId, lunoraNodes } = await seed();
  const response = await mf.dispatchFetch(
    `http://fixture/_lunora/ws?shard=${userId}`,
    {
      headers: { Upgrade: "websocket" },
    },
  );
  const ws = response.webSocket;
  if (!ws) throw new Error("Lunora WebSocket upgrade failed");
  ws.accept();
  const messages: unknown[] = [];
  let retirementStatus: string | undefined;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    if (message["shapeId"] === "retirement") {
      for (const op of message.rowsPatch ?? []) {
        if (op.value) retirementStatus = op.value.status;
      }
    }
  });
  try {
    ws.send(
      JSON.stringify({
        type: "connect",
        id: "connect",
        clientId: "retirement-test",
      }),
    );
    ws.send(
      JSON.stringify({
        type: "shape_subscribe",
        id: "outline",
        ["shape"]: { name: "wholeOutline" },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "shape_subscribe",
        id: "retirement",
        ["shape"]: { name: "userRetirementState" },
      }),
    );
    await expect
      .poll(() => messages)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "pokePart",
            ["shapeId"]: "outline",
            rowsPatch: expect.arrayContaining(
              lunoraNodes.map((row) =>
                expect.objectContaining({
                  op: "insert",
                  key: row.id,
                  value: expect.objectContaining({ userId, text: row.text }),
                }),
              ),
            ),
          }),
        ]),
      );
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "error" })]),
    );
    expect(retirementStatus).toBeUndefined();
    expect((await command<RetirementRecord>("/run", userId)).state).toBe(
      "completed",
    );
    await expect.poll(() => retirementStatus).toBe("retired");
  } finally {
    ws.close();
  }
});

test("cutover preserves all collections, rejects stale writes, and resnapshots classic sockets", async () => {
  const { userId, lunoraNodes } = await seed();
  const before = await command<Inspection>("/inspect", userId);
  const ws = await connect(userId);
  await frame(ws, null);
  const closed = new Promise((resolve) =>
    ws.addEventListener("close", resolve, { once: true }),
  );
  const migrated = await command<RetirementRecord>("/run", userId);
  expect(migrated.state).toBe("completed");
  await closed;
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toEqual(expect.arrayContaining(lunoraNodes));
  expect(after.classic.nodes).toHaveLength(3);
  expect(after.status.frozenBy).toBeNull();
  expect(after.lunora.retirement?.status).toBe("retired");
  expect(after.classic.kv.map((row) => row.collection).sort()).toEqual([
    "account-prefs",
    "account-prefs",
    "daily-index",
    "saved-queries",
    "tag-colors",
  ]);
  expect(after.classic.kv.find((row) => row.key === "timezone")?.value).toBe(
    '{"id":"timezone","zone":"America/Chicago"}',
  );
  expect(after.classic.kv.find((row) => row.key === "lunora-beta")?.value).toBe(
    '{"id":"lunora-beta","enabled":false}',
  );
  expect(
    after.classic.kv.find((row) => row.collection === "daily-index")?.value,
  ).toBe(JSON.stringify({ key: "2026-10-02", nodeId: lunoraNodes[0]?.id }));
  const reconnected = await connect(userId);
  expect(await frame(reconnected, before.classic.seq)).toMatchObject({
    type: "snapshot",
    nodes: expect.arrayContaining(lunoraNodes),
  });
  reconnected.close();
  for (const path of ["/write", "/browser-write"]) {
    const response = await mf.dispatchFetch(`http://fixture${path}`, {
      method: "POST",
      body: JSON.stringify({ userId, lunoraNodes }),
    });
    expect(response.status).toBe(409);
    // Lunora masks internal mutation errors. Check rejection and stored content,
    // rather than relying on the underlying fence error reaching the client.
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    const rejected = await command<Inspection>("/inspect", userId);
    expect(rejected.classic.nodes).toEqual(after.classic.nodes);
    expect(rejected.lunora.snapshot.nodes).toEqual(after.lunora.snapshot.nodes);
  }
  await command("/run", userId, { operation: "dry-run" });
  await command("/run", userId, { operation: "retry" });
  expect((await command<Inspection>("/inspect", userId)).record).toEqual(
    migrated,
  );
  const bucket = await mf.getR2Bucket("BACKUPS");
  const backup = await bucket.get(migrated.lunoraSnapshotKey ?? "");
  expect(backup).not.toBeNull();
  expect(await backup?.json()).toMatchObject({
    nodes: expect.arrayContaining(
      lunoraNodes.map((row) => ({ ...row, userId })),
    ),
  });
});

for (const fault of [undefined, "retire"] as const) {
  test(`deleted daily claims survive ${fault ? "failed cutover rollback" : "cutover and operator restore"}`, async () => {
    const userId = randomUUID();
    const classicRoot = node("classic root");
    const classicDay = node("deleted classic day", classicRoot.id);
    const lunoraRoot = node("experimental root");
    const lunoraDay = node("deleted experimental day", lunoraRoot.id);
    const classicClaim = { key: "2024-02-12", nodeId: classicDay.id };
    const lunoraClaim = {
      key: "2024-08-11",
      nodeId: lunoraDay.id,
      touchedAt: 7,
    };
    await command("/seed", userId, {
      classicNodes: [classicRoot, classicDay],
      lunoraNodes: [lunoraRoot, lunoraDay],
      classicDailyIndex: [classicClaim],
      lunoraDailyIndex: [lunoraClaim],
    });
    await command("/delete", userId, {
      classicNodes: [classicDay],
      lunoraNodes: [lunoraDay],
    });
    const before = await command<Inspection>("/inspect", userId);
    expect(before.classic.nodes).toEqual([classicRoot]);
    expect(before.lunora.snapshot.nodes).toEqual([{ ...lunoraRoot, userId }]);
    expect(
      before.classic.kv.filter((row) => row.collection === "daily-index"),
    ).toEqual([
      {
        collection: "daily-index",
        key: classicClaim.key,
        value: JSON.stringify(classicClaim),
        updatedAt: expect.any(Number),
      },
    ]);
    expect(before.lunora.snapshot.dailyIndex).toEqual([
      { ...lunoraClaim, userId },
    ]);
    expect(
      (
        await command<RetirementRecord>("/run", userId, {
          operation: "dry-run",
        })
      ).classification,
    ).toBe("eligible");
    const migrated = await command<RetirementRecord>("/run", userId, { fault });
    expect(migrated.state).toBe(fault ? "rolled-back" : "completed");
    const bucket = await mf.getR2Bucket("BACKUPS");
    const classicBackup = await bucket.get(migrated.classicSnapshotKey ?? "");
    expect(await classicBackup?.json()).toMatchObject({
      nodes: [classicRoot],
      kv: before.classic.kv,
    });
    const lunoraBackup = await bucket.get(migrated.lunoraSnapshotKey ?? "");
    expect(await lunoraBackup?.json()).toMatchObject({
      dailyIndex: [{ ...lunoraClaim, userId }],
    });
    if (!fault) {
      const cutover = await command<Inspection>("/inspect", userId);
      expect(cutover.classic.nodes).toEqual([lunoraRoot]);
      expect(
        cutover.classic.kv.filter((row) => row.collection === "daily-index"),
      ).toEqual([
        {
          collection: "daily-index",
          key: "2024-08-11",
          value: JSON.stringify({ key: "2024-08-11", nodeId: lunoraDay.id }),
          updatedAt: 7,
        },
      ]);
      expect(
        (
          await command<RetirementRecord>("/run", userId, {
            operation: "restore",
          })
        ).state,
      ).toBe("restored-pre-migration");
    }
    const restored = await command<Inspection>("/inspect", userId);
    expect(restored.classic.nodes).toEqual([classicRoot]);
    expect(
      restored.classic.kv.filter((row) => row.collection === "daily-index"),
    ).toEqual(
      before.classic.kv.filter((row) => row.collection === "daily-index"),
    );
    expect(restored.lunora.snapshot.dailyIndex).toEqual([
      { ...lunoraClaim, userId },
    ]);
    expect(restored.status.frozenBy).toBeNull();
    expect(restored.lunora.retirement?.status ?? null).toBe(
      fault ? null : "retired",
    );
  });
}

for (const afterRetire of [false, true]) {
  test(`retry resumes interruption ${afterRetire ? "after retirement" : "after classic replacement"}`, async () => {
    const { userId, lunoraNodes } = await seed();
    const interrupted = await command<{ migrationId: string }>(
      "/interrupt",
      userId,
      { afterRetire },
    );
    const preview = await command<RetirementRecord>("/run", userId, {
      operation: "dry-run",
    });
    expect(preview.state).toBe("backups-verified");
    const migrated = await command<RetirementRecord>("/run", userId, {
      operation: "retry",
    });
    expect(migrated.state).toBe("completed");
    expect(migrated.migrationId).toBe(interrupted.migrationId);
    expect(
      (await command<Inspection>("/inspect", userId)).classic.nodes,
    ).toEqual(expect.arrayContaining(lunoraNodes));
  });
}

test("retry after rollback rejects changed source without losing newer edits or replacing backups", async () => {
  const { userId, lunoraNodes, classicNodes } = await seed();
  const first = await command<RetirementRecord>("/run", userId, {
    fault: "retire",
  });
  expect(first.state).toBe("rolled-back");
  const bucket = await mf.getR2Bucket("BACKUPS");
  const original = await (
    await bucket.get(first.lunoraSnapshotKey ?? "")
  )?.text();
  const edited = lunoraNodes.map((row, i) =>
    i === 0
      ? { ...row, text: "newer edit after rollback", updatedAt: 15 }
      : row,
  );
  await command("/write", userId, { lunoraNodes: edited });
  const retry = await command<RetirementRecord>("/run", userId, {
    operation: "retry",
  });
  expect(retry.result).toBe("failed-before-restore");
  expect(retry.failureReason).toContain("Lunora content changed");
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toEqual(classicNodes);
  expect(after.lunora.snapshot.nodes).toEqual(
    expect.arrayContaining(edited.map((row) => ({ ...row, userId }))),
  );
  expect(after.status.frozenBy).toBeNull();
  expect(after.lunora.retirement).toBeNull();
  expect(await (await bucket.get(first.lunoraSnapshotKey ?? ""))?.text()).toBe(
    original,
  );
});

test("verification mismatch rolls back exactly; an uncertain rollback stays fenced until explicit recovery", async () => {
  for (const fault of ["verify", "rollback"] satisfies Input["fault"][]) {
    const { userId, classicNodes } = await seed();
    const first = await command<RetirementRecord>("/run", userId, { fault });
    if (fault === "verify") {
      expect(first.state).toBe("rolled-back");
    } else {
      expect(first.state).toBe("uncertain");
      await command("/run", userId, { operation: "dry-run" });
      await command("/run", userId, { operation: "retry" });
      const frozen = await command<Inspection>("/inspect", userId);
      expect(frozen.record).toEqual(first);
      expect(frozen.status.frozenBy).toBe(first.migrationId);
      expect(frozen.lunora.retirement?.status).toBe("frozen");
      expect(
        (
          await command<RetirementRecord>("/run", userId, {
            operation: "restore",
          })
        ).state,
      ).toBe("restored-pre-migration");
    }
    const after = await command<Inspection>("/inspect", userId);
    expect(after.classic.nodes).toEqual(classicNodes);
    expect(after.status.frozenBy).toBeNull();
    expect(after.lunora.retirement).toBeNull();
  }
});

for (const operation of [
  "restore",
  "migrate",
  "retry",
  "dry-run",
] satisfies Input["operation"][]) {
  test(`rejects overlapping ${operation} before any backend call`, async () => {
    const { userId, lunoraNodes } = await seed();
    const raced = await command<
      Inspection & {
        migration: RetirementRecord;
        rejected: boolean;
        backendCalls: number;
      }
    >("/race", userId, { operation });
    expect(raced.rejected).toBe(true);
    expect(raced.backendCalls).toBe(0);
    expect(raced.migration.state).toBe("completed");
    expect(raced.lunora.retirement?.status).toBe("retired");
    expect(raced.classic.nodes).toEqual(expect.arrayContaining(lunoraNodes));
    expect(raced.status.frozenBy).toBeNull();
    expect(
      raced.classic.kv.find((row) => row.key === "lunora-beta")?.value,
    ).toBe('{"id":"lunora-beta","enabled":false}');
    const retried = await command<RetirementRecord>("/run", userId, {
      operation: "retry",
    });
    expect(retried).toEqual(raced.migration);
    expect(retried.activeOperationId).toBeNull();
  });
}

test("an old interrupted claim stays held until exact-token operator recovery", async () => {
  const { userId } = await seed();
  const initial = await command<RetirementRecord>("/run", userId, {
    operation: "dry-run",
  });
  const db = await mf.getD1Database("DB");
  const operationId = randomUUID();
  await db
    .prepare(
      "UPDATE lunora_retirement SET activeOperationId = ?, activeOperationStartedAt = 0 WHERE userId = ?",
    )
    .bind(operationId, userId)
    .run();
  const held = await command<Inspection>("/inspect", userId);
  for (const operation of ["migrate", "retry", "restore", "dry-run"]) {
    const response = await mf.dispatchFetch("http://fixture/run", {
      method: "POST",
      body: JSON.stringify({ userId, operation }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "retirement_operation_in_progress",
    });
    const rejected = await command<Inspection>("/inspect", userId);
    expect(rejected.record).toEqual(held.record);
    expect(rejected.classic).toMatchObject({
      nodes: held.classic.nodes,
      kv: held.classic.kv,
    });
    expect(rejected.lunora.snapshot.nodes).toEqual(held.lunora.snapshot.nodes);
  }
  const release = db.prepare(
    "UPDATE lunora_retirement SET activeOperationId = NULL, activeOperationStartedAt = NULL WHERE userId = ? AND migrationId = ? AND activeOperationId = ?",
  );
  await release
    .bind(userId, initial.migrationId, "wrong-operation-token")
    .run();
  expect(
    (await command<Inspection>("/inspect", userId)).record.activeOperationId,
  ).toBe(operationId);
  // This isolated test executor is known stopped; production requires that check first.
  await release.bind(userId, initial.migrationId, operationId).run();
  const resumed = await command<RetirementRecord>("/run", userId, {
    operation: "retry",
  });
  expect(resumed.state).toBe("completed");
  expect(resumed.migrationId).toBe(initial.migrationId);
  expect(resumed.activeOperationId).toBeNull();
});

test("the operator CLI stops its batch on conflict, uncertainty, or failed migration", async () => {
  for (const outcome of [
    "backend-conflict",
    "uncertain",
    "failed",
    "invalid",
  ]) {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(
          JSON.stringify({
            userIds: ["done", "classic", "pilot", "review", "unreached"],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      // SAFETY: the test invokes only this CLI's known one-user JSON request format.
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        userId: string;
        operation: string;
      };
      calls.push(`${body.operation}:${body.userId}`);
      if (outcome === "invalid" && body.userId === "pilot") {
        response.end(JSON.stringify({ state: 7, classification: "eligible" }));
        return;
      }
      let state = "classified";
      let classification = "eligible";
      if (body.userId === "done") state = "completed";
      if (body.userId === "classic") classification = "already-classic";
      if (body.userId === "review") {
        if (outcome === "uncertain") state = "uncertain";
        else classification = "backend-conflict";
      }
      if (body.operation === "migrate")
        state = outcome === "failed" ? "failed" : "completed";
      response.end(
        JSON.stringify({ state, classification, migrationId: "audit-id" }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    // SAFETY: listen above binds a TCP port, not a Unix socket, and has completed.
    const address = server.address() as AddressInfo;
    try {
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(
            "bun",
            [
              "scripts/lunora-retirement.ts",
              "migrate",
              "--all",
              "--execute",
              "--api",
              `http://127.0.0.1:${address.port}`,
            ],
            {
              env: { ...process.env, DOTFLOWY_SESSION_COOKIE: "local-fixture" },
            },
          );
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.resume();
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
        },
      );
      expect(result.code).toBe(1);
      if (outcome === "invalid") {
        expect(calls).toEqual([
          "dry-run:done",
          "dry-run:classic",
          "dry-run:pilot",
        ]);
        expect(result.stdout).toBe("");
        continue;
      }
      expect(calls).toEqual(
        outcome === "failed"
          ? [
              "dry-run:done",
              "dry-run:classic",
              "dry-run:pilot",
              "migrate:pilot",
            ]
          : [
              "dry-run:done",
              "dry-run:classic",
              "dry-run:pilot",
              "migrate:pilot",
              "dry-run:review",
            ],
      );
      const output = JSON.parse(result.stdout);
      expect(output).toHaveLength(outcome === "failed" ? 3 : 4);
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ migrationId: "audit-id" }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
