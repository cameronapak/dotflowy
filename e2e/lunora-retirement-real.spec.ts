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
import {
  ClassicRecoveryManifestSchema,
  ExperimentalPrimaryRecoveryManifestSchema,
} from "../worker/lunora-recovery";
import {
  ClassicLinkRepairManifestSchema,
  compareRetirementSnapshots,
  LunoraRetirementArchiveSchema,
} from "../worker/lunora-retirement";

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
            BETTER_AUTH_SECRET: {
              type: "text",
              value: "disposable-retirement-test-secret-not-for-production",
            },
            BETTER_AUTH_URL: { type: "text", value: "http://fixture" },
            SIGNUP_OPEN: { type: "text", value: "true" },
            ADMIN_EMAILS: {
              type: "text",
              value: "diagnostic-admin@dotflowy.local",
            },
            OWNER_USER_ID: { type: "text", value: "diagnostic-owner" },
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
    "0003_create_auth.sql",
    "0010_lunora_retirement.sql",
    "0011_lunora_retirement_operation_claim.sql",
    "0013_preserve_classic_retirement.sql",
  ]) {
    const sql = await readFile(`migrations/${migration}`, "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").replaceAll("\n", " "));
  }
});

test.afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("production diagnostic is admin-only, content-free, and leaves outline and audit storage unchanged", async () => {
  const db = await mf.getD1Database("DB");
  const signUp = async (email: string) => {
    const response = await mf.dispatchFetch(
      "http://fixture/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://fixture",
        },
        body: JSON.stringify({
          email,
          name: "Diagnostic fixture",
          password: "disposable-test-password",
        }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    // Disposable local fixture only: production requires verified email before sign-in.
    await db
      .prepare('UPDATE "user" SET emailVerified=1 WHERE email=?')
      .bind(email)
      .run();
    const signedIn = await mf.dispatchFetch(
      "http://fixture/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://fixture",
        },
        body: JSON.stringify({ email, password: "disposable-test-password" }),
      },
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    return cookie;
  };
  const adminCookie = await signUp("diagnostic-admin@dotflowy.local");
  const otherCookie = await signUp("diagnostic-nonadmin@dotflowy.local");
  const userId = "diagnostic-owner";
  await db
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .bind(
      userId,
      "Owner fixture",
      "diagnostic-owner@dotflowy.local",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const root = node("SECRET_OUTLINE_TEXT");
  const parent = node("SECRET_PARENT_TEXT", root.id);
  const child = node("SECRET_CHILD_TEXT", parent.id);
  await command("/seed", userId, {
    classicNodes: [root, parent, child],
    lunoraNodes: [root, child],
  });
  const before = await command<Inspection>("/inspect", userId);
  const auditBefore = await db.prepare("SELECT * FROM lunora_retirement").all();
  const attemptsBefore = await db
    .prepare("SELECT * FROM lunora_retirement_attempt")
    .all();
  const backupsBefore = await (await mf.getR2Bucket("BACKUPS")).list();
  const path = `http://fixture/api/admin/lunora-retirement?diagnostic=1&userId=${userId}`;
  for (const cookie of ["", otherCookie]) {
    const denied = await mf.dispatchFetch(path, { headers: { cookie } });
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(await denied.json()).toEqual({ error: "not found" });
  }
  const response = await mf.dispatchFetch(path, {
    headers: { cookie: adminCookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const serialized = await response.text();
  expect(serialized).not.toContain("SECRET_");
  expect(serialized).not.toContain("#work");
  expect(serialized).not.toContain('"blue"');
  const report: ReturnType<typeof compareRetirementSnapshots> =
    JSON.parse(serialized);
  expect(report.nodes.classicOnly).toMatchObject({
    count: 1,
    sample: [parent.id],
  });
  expect(report.graphs.experimental.missingReferences).toMatchObject({
    count: 1,
    sample: [
      {
        nodeId: child.id,
        field: "parentId",
        referencedId: parent.id,
        presentInOtherBackend: true,
      },
    ],
  });
  // Email is only a lookup: owner-continuity still routes classic to 'default'.
  const byEmail = await mf.dispatchFetch(
    "http://fixture/api/admin/lunora-retirement?diagnostic=1&email=diagnostic-owner%40dotflowy.local",
    { headers: { cookie: adminCookie } },
  );
  expect(byEmail.status).toBe(200);
  expect(await byEmail.json()).toMatchObject({
    nodes: { classic: 3, experimental: 2 },
  });
  for (const query of [
    "",
    "&userId=unknown",
    `&userId=${userId}&email=diagnostic-owner%40dotflowy.local`,
  ]) {
    const invalid = await mf.dispatchFetch(
      `http://fixture/api/admin/lunora-retirement?diagnostic=1${query}`,
      { headers: { cookie: adminCookie } },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("private, no-store");
  }
  for (const cookie of ["", otherCookie, adminCookie]) {
    const post = await mf.dispatchFetch(path, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://fixture",
      },
      body: JSON.stringify({ userId, operation: "migrate" }),
    });
    expect(post.status).toBe(cookie === adminCookie ? 405 : 404);
    expect(post.headers.get("cache-control")).toBe("private, no-store");
  }
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toEqual(before.classic.nodes);
  expect(after.classic.kv).toEqual(before.classic.kv);
  expect(after.classic.seq).toBe(before.classic.seq);
  expect(after.lunora.snapshot).toMatchObject({
    nodes: before.lunora.snapshot.nodes,
    dailyIndex: before.lunora.snapshot.dailyIndex,
    tagColors: before.lunora.snapshot.tagColors,
    savedQueries: before.lunora.snapshot.savedQueries,
    migrateState: before.lunora.snapshot.migrateState,
  });
  expect(after.status).toEqual(before.status);
  expect(after.lunora.retirement).toEqual(before.lunora.retirement);
  const emptyUserId = "diagnostic-empty-experimental";
  await db
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .bind(
      emptyUserId,
      "Empty fixture",
      "diagnostic-empty@dotflowy.local",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await command("/seed", emptyUserId, {
    classicNodes: [node("SECRET_CLASSIC_ONLY_TEXT")],
  });
  const emptyBefore = await command<Inspection>("/inspect", emptyUserId);
  const empty = await mf.dispatchFetch(
    `http://fixture/api/admin/lunora-retirement?diagnostic=1&userId=${emptyUserId}`,
    { headers: { cookie: adminCookie } },
  );
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({
    nodes: { classic: 1, experimental: 0 },
    sideCollections: {
      dailyIndex: { experimental: 0 },
      tagColors: { experimental: 0 },
      savedQueries: { experimental: 0 },
    },
  });
  const emptyAfter = await command<Inspection>("/inspect", emptyUserId);
  expect(emptyAfter.lunora.snapshot).toMatchObject({
    nodes: [],
    dailyIndex: [],
    tagColors: [],
    savedQueries: [],
    migrateState: [],
  });
  expect(emptyAfter.classic.nodes).toEqual(emptyBefore.classic.nodes);
  expect(emptyAfter.classic.kv).toEqual(emptyBefore.classic.kv);
  expect(emptyAfter.classic.seq).toBe(emptyBefore.classic.seq);
  expect(emptyAfter.status).toEqual(emptyBefore.status);
  expect(emptyAfter.lunora.retirement).toEqual(emptyBefore.lunora.retirement);
  expect(
    (await db.prepare("SELECT * FROM lunora_retirement").all()).results,
  ).toEqual(auditBefore.results);
  expect(
    (await db.prepare("SELECT * FROM lunora_retirement_attempt").all()).results,
  ).toEqual(attemptsBefore.results);
  expect((await (await mf.getR2Bucket("BACKUPS")).list()).objects).toEqual(
    backupsBefore.objects,
  );
});

test("production manual operations enforce admin, manifest approval and content-free responses", async () => {
  const signedIn = await mf.dispatchFetch(
    "http://fixture/api/auth/sign-in/email",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://fixture" },
      body: JSON.stringify({
        email: "diagnostic-admin@dotflowy.local",
        password: "disposable-test-password",
      }),
    },
  );
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const userId = randomUUID();
  const current = node("PRIVATE_CLASSIC_SENTINEL");
  await (
    await mf.getD1Database("DB")
  )
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .bind(
      userId,
      "Manual fixture",
      `${userId}@dotflowy.local`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await command("/seed", userId, {
    classicNodes: [current],
    lunoraNodes: [node("PRIVATE_EXPERIMENTAL_SENTINEL", randomUUID())],
    preferenceEnabled: false,
  });
  const request = (
    operation: string,
    sessionCookie = cookie,
    approvedManifestHash?: string,
  ) =>
    mf.dispatchFetch("http://fixture/api/admin/lunora-retirement", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "content-type": "application/json",
        origin: "http://fixture",
      },
      body: JSON.stringify({ userId, operation, approvedManifestHash }),
    });
  for (const operation of [
    "preserve-classic",
    "recover-classic",
    "migrate-with-recovery",
    "repair-classic",
  ])
    expect((await request(operation, "")).status).toBe(404);
  const preserved = await request("preserve-classic");
  expect(preserved.status).toBe(200);
  expect(preserved.headers.get("cache-control")).toBe("private, no-store");
  const body = await preserved.text();
  expect(body).not.toContain("PRIVATE_CLASSIC_SENTINEL");
  expect(body).not.toContain("PRIVATE_EXPERIMENTAL_SENTINEL");
  const record = Schema.decodeUnknownSync(
    Schema.Struct({
      state: Schema.String,
      recoveryManifestHash: Schema.String,
    }),
  )(JSON.parse(body));
  expect(record.state).toBe("completed");
  expect((await request("recover-classic")).status).toBe(409);
  expect((await request("recover-classic", cookie, "wrong-hash")).status).toBe(
    409,
  );
  expect((await request("migrate")).status).toBe(409);
  expect((await request("migrate-with-recovery")).status).toBe(409);
  expect((await request("restore")).status).toBe(409);
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    [current],
  );
  const recovered = await request(
    "recover-classic",
    cookie,
    record.recoveryManifestHash!,
  );
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    result: "classic-recovery-imported",
  });
});

test("production repair preview and execution require an admin session and return no node content", async () => {
  const login = async (email: string) => {
    const response = await mf.dispatchFetch(
      "http://fixture/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://fixture",
        },
        body: JSON.stringify({ email, password: "disposable-test-password" }),
      },
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  };
  const admin = await login("diagnostic-admin@dotflowy.local");
  const nonadmin = await login("diagnostic-nonadmin@dotflowy.local");
  const userId = randomUUID();
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .bind(
      userId,
      "Repair fixture",
      `${userId}@dotflowy.local`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await command("/seed", userId, {
    classicNodes: [node("PRIVATE_REPAIR_SENTINEL"), node("second")],
    preferenceEnabled: false,
  });
  const before = await command<Inspection>("/inspect", userId);
  const path = `http://fixture/api/admin/lunora-retirement?repairPreview=1&userId=${userId}`;
  for (const cookie of ["", nonadmin])
    expect((await mf.dispatchFetch(path, { headers: { cookie } })).status).toBe(
      404,
    );
  const response = await mf.dispatchFetch(path, { headers: { cookie: admin } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const text = await response.text();
  expect(text).not.toContain("PRIVATE_REPAIR_SENTINEL");
  const preview = Schema.decodeUnknownSync(
    Schema.Struct({
      userId: Schema.String,
      eligible: Schema.Boolean,
      approvalHash: Schema.String,
    }),
  )(JSON.parse(text));
  expect(preview).toMatchObject({ userId, eligible: true });
  const afterPreview = await command<Inspection>("/inspect", userId);
  expect(afterPreview.classic).toEqual({
    ...before.classic,
    exportedAt: afterPreview.classic.exportedAt,
  });
  expect(afterPreview.lunora).toEqual({
    ...before.lunora,
    snapshot: {
      ...before.lunora.snapshot,
      exportedAt: afterPreview.lunora.snapshot.exportedAt,
    },
  });
  expect(afterPreview.status).toEqual(before.status);
  expect(afterPreview.record).toEqual(before.record);
  const repair = (cookie: string, approvedManifestHash?: string) =>
    mf.dispatchFetch("http://fixture/api/admin/lunora-retirement", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://fixture",
      },
      body: JSON.stringify({
        userId,
        operation: "repair-classic",
        approvedManifestHash,
      }),
    });
  expect((await repair(nonadmin, preview.approvalHash)).status).toBe(404);
  expect((await repair(admin)).status).toBe(409);
  const repaired = await repair(admin, preview.approvalHash);
  expect(repaired.status).toBe(200);
  const result = await repaired.text();
  expect(result).not.toContain("PRIVATE_REPAIR_SENTINEL");
  expect(JSON.parse(result)).toMatchObject({
    state: "completed",
    policy: "classic-link-repair-v1",
    result: "classic-links-repaired",
  });
});

for (const corruption of ["fan", "heads", "orphan"] as const) {
  test(`Classic link repair archives and preserves ${corruption} payloads and forces a fresh socket snapshot`, async () => {
    const userId = randomUUID();
    const root = node("retained root");
    const a = node(
      "retained task",
      corruption === "heads"
        ? null
        : corruption === "orphan"
          ? randomUUID()
          : root.id,
    );
    a.isTask = true;
    a.completed = true;
    const b = node(
      "retained descendant",
      corruption === "orphan" ? a.id : root.id,
      corruption === "fan" ? a.id : null,
    );
    const c = node("retained losing branch", root.id, a.id);
    const rows =
      corruption === "fan"
        ? [root, a, b, c]
        : corruption === "heads"
          ? [root, a]
          : [root, a, b];
    const original = await command<{ classic: OutlineSnapshot }>(
      "/seed",
      userId,
      {
        classicNodes: rows,
        preferenceEnabled: false,
        classicDailyIndex: [
          { key: "2026-10-03", nodeId: "retained-deleted-claim" },
        ],
      },
    );
    const preview = await command<{ eligible: boolean; approvalHash: string }>(
      "/repair-preview",
      userId,
    );
    expect(preview.eligible).toBe(true);
    const result = await command<RetirementRecord>("/run", userId, {
      operation: "repair-classic",
      approvedManifestHash: preview.approvalHash,
    });
    expect(result).toMatchObject({
      state: "completed",
      result: "classic-links-repaired",
      policy: "classic-link-repair-v1",
      classification: "already-classic",
      activeOperationId: null,
    });
    const after = await command<Inspection>("/inspect", userId);
    const expected = rows.map((row) =>
      row.id === c.id && corruption === "fan"
        ? { ...row, prevSiblingId: b.id }
        : row.id === a.id && corruption !== "fan"
          ? { ...row, parentId: null, prevSiblingId: root.id }
          : row,
    );
    expect(after.classic.nodes).toEqual(expected);
    expect(after.classic.kv.filter((row) => row.key !== "lunora-beta")).toEqual(
      original.classic.kv.filter((row) => row.key !== "lunora-beta"),
    );
    expect(after.status.frozenBy).toBeNull();
    expect(after.lunora.retirement?.status).toBe("retired");
    const bucket = await mf.getR2Bucket("BACKUPS");
    const backup = await bucket.get(result.classicSnapshotKey!);
    expect((await backup?.json<OutlineSnapshot>())?.nodes).toEqual(rows);
    const manifest = Schema.decodeUnknownSync(ClassicLinkRepairManifestSchema)(
      await (await bucket.get(result.recoveryManifestKey!))?.json(),
    );
    expect(manifest.nodes).toEqual(expected);
    const ws = await connect(userId);
    const snapshot = await frame(ws, original.classic.seq);
    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type === "snapshot") expect(snapshot.nodes).toEqual(expected);
    ws.close();
  });
}

for (const fault of ["verify", "rollback"] as const) {
  test(`Classic link repair ${fault === "verify" ? "restores exact original data" : "retains both fences on uncertain rollback"}`, async () => {
    const userId = randomUUID();
    const rows = [node("first"), node("second")];
    const original = await command<{ classic: OutlineSnapshot }>(
      "/seed",
      userId,
      { classicNodes: rows, preferenceEnabled: false },
    );
    const preview = await command<{ approvalHash: string }>(
      "/repair-preview",
      userId,
    );
    const result = await command<RetirementRecord>("/run", userId, {
      operation: "repair-classic",
      approvedManifestHash: preview.approvalHash,
      fault,
    });
    expect(result.state).toBe(fault === "verify" ? "rolled-back" : "uncertain");
    const after = await command<Inspection>("/inspect", userId);
    if (fault === "verify") {
      expect(after.classic.nodes).toEqual(rows);
      expect(after.classic.kv).toEqual(original.classic.kv);
      expect(after.status.frozenBy).toBeNull();
      expect(after.lunora.retirement).toBeNull();
      const resumed = await command<RetirementRecord>("/run", userId, {
        operation: "retry",
      });
      expect(resumed.state).toBe("completed");
      expect(resumed.recoveryManifestHash).toBe(result.recoveryManifestHash);
      expect(resumed.classicSnapshotHash).toBe(result.classicSnapshotHash);
      expect(
        (await command<Inspection>("/inspect", userId)).classic.nodes,
      ).toEqual(
        rows.map((row, i) =>
          i === 1 ? { ...row, prevSiblingId: rows[0]!.id } : row,
        ),
      );
    } else {
      expect(after.status.frozenBy).toBe(result.migrationId);
      expect(after.lunora.retirement?.status).toBe("frozen");
      const retried = await command<RetirementRecord>("/run", userId, {
        operation: "retry",
      });
      expect(retried.state).toBe("uncertain");
    }
  });
}

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

test("experimental-primary recovery atomically preserves sixteen live nodes and copies ten disjoint Classic nodes", async () => {
  const userId = randomUUID();
  const chain = (name: string, count: number) => {
    const rows: Node[] = [];
    for (let i = 0; i < count; i++)
      rows.push(node(`${name} ${i}`, null, rows.at(-1)?.id ?? null));
    return rows;
  };
  const classicNodes = chain("PRIVATE_CLASSIC_FIXTURE", 10);
  const lunoraNodes = chain("PRIVATE_EXPERIMENTAL_FIXTURE", 16);
  await command("/seed", userId, {
    classicNodes: [...classicNodes].reverse(),
    lunoraNodes: [...lunoraNodes].reverse(),
  });
  const before = await command<Inspection>("/inspect", userId);
  const completed = await command<RetirementRecord>("/run", userId, {
    operation: "migrate-with-recovery",
  });
  expect(completed).toMatchObject({
    state: "completed",
    result: "migrated-with-classic-recovery",
    policy: "experimental-primary-recovery-v1",
    failureReason: null,
    activeOperationId: null,
  });
  expect(JSON.stringify(completed)).not.toContain("PRIVATE_");
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toHaveLength(29);
  expect(after.classic.nodes).toEqual(expect.arrayContaining(lunoraNodes));
  const root = after.classic.nodes.find(
    (row) => row.text === "Recovered Classic content",
  );
  expect(root?.prevSiblingId).toBe(lunoraNodes.at(-1)?.id);
  expect(after.lunora.retirement?.status).toBe("retired");
  expect(after.status.frozenBy).toBeNull();
  expect(JSON.parse(completed.counts ?? "{}").recovery).toMatchObject({
    classicOnly: 10,
    substantiveAlternatives: 0,
    copies: 13,
    adaptations: 0,
  });
  const bucket = await mf.getR2Bucket("BACKUPS");
  const manifestObject = await bucket.get(completed.recoveryManifestKey ?? "");
  const manifest = Schema.decodeUnknownSync(
    ExperimentalPrimaryRecoveryManifestSchema,
  )(JSON.parse((await manifestObject?.text()) ?? "null"));
  for (const original of classicNodes) {
    const copy = manifest.copies.find((row) => row.sourceId === original.id);
    expect(copy).toBeDefined();
    expect(
      after.classic.nodes.find((row) => row.id === copy?.copyId)?.text,
    ).toBe(original.text);
    expect(after.classic.nodes.some((row) => row.id === original.id)).toBe(
      false,
    );
  }
  const classicArchive = await bucket.get(completed.classicSnapshotKey ?? "");
  expect(JSON.parse((await classicArchive?.text()) ?? "null").nodes).toEqual(
    before.classic.nodes,
  );
  const liveDaily = after.classic.kv
    .filter((row) => row.collection === "daily-index")
    .map((row) => JSON.parse(row.value));
  expect(liveDaily).toEqual(
    before.lunora.snapshot.dailyIndex.map(({ key, nodeId }) => ({
      key,
      nodeId,
    })),
  );
  const recovered = after.classic.nodes.find(
    (row) => row.text === classicNodes[0]?.text,
  )!;
  await command("/classic-write", userId, {
    classicNodes: [{ ...recovered, text: "Edited recovered Classic note" }],
  });
  await command("/classic-write", userId, {
    classicNodes: [
      { ...lunoraNodes[0]!, text: "New working-outline edit after migration" },
    ],
  });
  const editedCopy = await command<Inspection>("/inspect", userId);
  expect(
    editedCopy.classic.nodes.find((row) => row.id === recovered.id)?.text,
  ).toBe("Edited recovered Classic note");
  await command("/classic-delete", userId, {
    classicNodes: after.classic.nodes.filter(
      (row) => !lunoraNodes.some((primary) => primary.id === row.id),
    ),
  });
  const edited = await command<Inspection>("/inspect", userId);
  await command("/run", userId, { operation: "retry" });
  const repeated = await command<Inspection>("/inspect", userId);
  expect(repeated.classic.nodes).toEqual(edited.classic.nodes);
  expect(repeated.classic.nodes).toHaveLength(16);
  expect(repeated.record.recoveryManifestHash).toBe(
    completed.recoveryManifestHash,
  );
});

for (const fault of ["retire", "verify"] as const) {
  test(`experimental-primary recovery rolls back ${fault} failure and reuses its persisted copies`, async () => {
    const { userId } = await seed();
    const before = await command<Inspection>("/inspect", userId);
    const failed = await command<RetirementRecord>("/run", userId, {
      operation: "migrate-with-recovery",
      fault,
    });
    expect(failed.state).toBe("rolled-back");
    const rollback = await command<Inspection>("/inspect", userId);
    expect(rollback.classic.nodes).toEqual(before.classic.nodes);
    const bucket = await mf.getR2Bucket("BACKUPS");
    const manifest = await bucket.get(failed.recoveryManifestKey ?? "");
    const saved = await manifest?.text();
    expect(saved).toBeDefined();
    const retried = await command<RetirementRecord>("/run", userId, {
      operation: "retry",
    });
    expect(retried.state, retried.failureReason ?? "").toBe("completed");
    expect(retried.result).toBe("migrated-with-classic-recovery");
    expect(retried.recoveryManifestHash).toBe(failed.recoveryManifestHash);
    expect(
      await (await bucket.get(retried.recoveryManifestKey ?? ""))?.text(),
    ).toBe(saved);
    const recovered = await command<Inspection>("/inspect", userId);
    const plan = Schema.decodeUnknownSync(
      ExperimentalPrimaryRecoveryManifestSchema,
    )(JSON.parse(saved!));
    expect(recovered.classic.nodes).toEqual(
      expect.arrayContaining(
        plan.nodes.map((row) =>
          row.id === plan.rootId
            ? {
                ...row,
                prevSiblingId: before.lunora.snapshot.nodes.find(
                  (n) => n.text === "Lunora sibling",
                )!.id,
              }
            : row,
        ),
      ),
    );
  });
}

test("experimental-primary recovery keeps post-unlock edits through a lost acknowledgement and uncertain retry", async () => {
  const { userId, lunoraNodes } = await seed();
  const uncertain = await command<RetirementRecord>("/run", userId, {
    operation: "migrate-with-recovery",
    fault: "unlock-ack",
  });
  expect(uncertain.state).toBe("uncertain");
  const committed = await command<Inspection>("/inspect", userId);
  expect(committed.status.frozenBy).toBeNull();
  expect(committed.lunora.retirement?.status).toBe("retired");
  expect(
    committed.classic.nodes.some(
      (row) => row.text === "Recovered Classic content",
    ),
  ).toBe(true);
  await command("/classic-write", userId, {
    classicNodes: [
      {
        ...lunoraNodes[0]!,
        text: "Edit after unlock but before audit completion",
      },
    ],
  });
  const edited = await command<Inspection>("/inspect", userId);
  const retry = await command<RetirementRecord>("/run", userId, {
    operation: "retry",
  });
  expect(retry.state).toBe("uncertain");
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    edited.classic.nodes,
  );
});

test("preserve-Classic keeps Classic byte semantics, archives raw unknown fields, and recovers only the exact reviewed manifest", async () => {
  const userId = randomUUID();
  const classicRoot = node("chosen Classic");
  const missingParent = randomUUID();
  const experimental = node("orphaned experimental", missingParent);
  await command("/seed", userId, {
    classicNodes: [classicRoot],
    lunoraNodes: [experimental],
    preferenceEnabled: false,
  });
  const before = await command<Inspection>("/inspect", userId);
  const preserved = await command<RetirementRecord>("/run", userId, {
    operation: "preserve-classic",
    preserveRawUnknownField: true,
  });
  expect(preserved).toMatchObject({
    policy: "preserve-classic-v1",
    state: "completed",
    result: "classic-preserved",
    recoveryManifestHash: expect.any(String),
  });
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toEqual(before.classic.nodes);
  expect(after.classic.kv).toEqual(before.classic.kv);
  expect(after.lunora.retirement?.status).toBe("retired");
  const bucket = await mf.getR2Bucket("BACKUPS");
  const archiveObject = await bucket.get(preserved.lunoraSnapshotKey ?? "");
  const archive = Schema.decodeUnknownSync(LunoraRetirementArchiveSchema)(
    JSON.parse((await archiveObject?.text()) ?? "null"),
  );
  expect(archive?.raw.nodes[0].futureUnknownField).toEqual({
    nested: [1, "retained", true],
  });
  expect(archive?.snapshot.nodes[0]).toMatchObject({
    id: experimental.id,
    parentId: missingParent,
  });
  const wrongHash = await mf.dispatchFetch("http://fixture/run", {
    method: "POST",
    body: JSON.stringify({
      userId,
      operation: "recover-classic",
      approvedManifestHash: `wrong-${preserved.recoveryManifestHash}`,
    }),
  });
  expect(wrongHash.status).toBe(409);
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    [classicRoot],
  );
  const recovered = await command<RetirementRecord>("/run", userId, {
    operation: "recover-classic",
    approvedManifestHash: preserved.recoveryManifestHash ?? undefined,
  });
  expect(recovered.result).toBe("classic-recovery-imported");
  const imported = (await command<Inspection>("/inspect", userId)).classic
    .nodes;
  expect(imported).toEqual(expect.arrayContaining([classicRoot]));
  expect(imported.some((value) => value.text === experimental.text)).toBe(true);

  const edit = node("Classic edit after unlock", classicRoot.id);
  await command("/classic-write", userId, { classicNodes: [edit] });
  const importedCopy = imported.find(
    (value) => value.text === experimental.text,
  );
  expect(importedCopy).toBeDefined();
  await command("/classic-delete", userId, {
    classicNodes: [importedCopy!],
  });
  await command("/run", userId, {
    operation: "recover-classic",
    approvedManifestHash: preserved.recoveryManifestHash ?? undefined,
  });
  const repeated = await command<Inspection>("/inspect", userId);
  expect(repeated.classic.nodes).toEqual(
    expect.arrayContaining([classicRoot, edit]),
  );
  expect(repeated.classic.nodes).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: importedCopy!.id })]),
  );
  const pitr = await mf.dispatchFetch("http://fixture/pitr", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  expect(pitr.status).toBe(409);
  for (const path of [
    "/snapshot-replace",
    "/reenable",
    "/write",
    "/browser-write",
  ]) {
    const rejected = await mf.dispatchFetch(`http://fixture${path}`, {
      method: "POST",
      body: JSON.stringify({
        userId,
        classicNodes: [node("must not replace Classic")],
        lunoraNodes: [experimental],
      }),
    });
    expect(rejected.status).toBe(409);
  }
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    repeated.classic.nodes,
  );
});

test("preserve-Classic rejects enabled preference before fencing or archiving", async () => {
  const { userId, classicNodes } = await seed();
  const response = await mf.dispatchFetch("http://fixture/run", {
    method: "POST",
    body: JSON.stringify({ userId, operation: "preserve-classic" }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error:
      "enabled accounts require full experimental migration, not preserve-Classic",
  });
  const after = await command<Inspection>("/inspect", userId);
  expect(after.classic.nodes).toEqual(classicNodes);
  expect(after.status.frozenBy).toBeNull();
  expect(after.lunora.retirement).toBeNull();
  expect(after.record.policy).toBe("lunora-to-classic-v1");
});

for (const fault of [
  "preserve-ack",
  "retire-ack",
  "unlock-ack",
] satisfies Input["fault"][]) {
  test(`preserve retry converges after lost ${fault}`, async () => {
    const userId = randomUUID();
    const classic = node("Classic remains authoritative");
    const experimental = node("experimental archive row");
    await command("/seed", userId, {
      classicNodes: [classic],
      lunoraNodes: [experimental],
      preferenceEnabled: false,
    });
    const first = await command<RetirementRecord>("/run", userId, {
      operation: "preserve-classic",
      fault,
    });
    expect(first.state).toBe("uncertain");
    const retried = await command<RetirementRecord>("/run", userId, {
      operation: "retry",
    });
    expect(retried).toMatchObject({
      state: "completed",
      result: "classic-preserved",
      migrationId: first.migrationId,
      classicSnapshotHash: first.classicSnapshotHash,
      lunoraSnapshotHash: first.lunoraSnapshotHash,
    });
    const final = await command<Inspection>("/inspect", userId);
    expect(final.classic.nodes).toEqual([classic]);
    expect(final.status.frozenBy).toBeNull();
    expect(final.lunora.retirement?.status).toBe("retired");
  });
}

test("lost recovery ACK is idempotent and does not duplicate imports", async () => {
  const userId = randomUUID();
  await command("/seed", userId, {
    classicNodes: [node("Classic")],
    lunoraNodes: [node("experimental only")],
    preferenceEnabled: false,
  });
  const preserved = await command<RetirementRecord>("/run", userId, {
    operation: "preserve-classic",
  });
  const failed = await mf.dispatchFetch("http://fixture/run", {
    method: "POST",
    body: JSON.stringify({
      userId,
      operation: "recover-classic",
      approvedManifestHash: preserved.recoveryManifestHash,
      fault: "import-ack",
    }),
  });
  expect(failed.status).toBe(409);
  const once = await command<Inspection>("/inspect", userId);
  await command("/run", userId, {
    operation: "recover-classic",
    approvedManifestHash: preserved.recoveryManifestHash ?? undefined,
  });
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    once.classic.nodes,
  );
});

test("recovery collision and corrupt immutable objects fail atomically", async () => {
  const userId = randomUUID();
  const classic = node("Classic");
  await command("/seed", userId, {
    classicNodes: [classic],
    lunoraNodes: [node("recover me")],
    preferenceEnabled: false,
  });
  const preserved = await command<RetirementRecord>("/run", userId, {
    operation: "preserve-classic",
  });
  const bucket = await mf.getR2Bucket("BACKUPS");
  const manifestObject = await bucket.get(preserved.recoveryManifestKey ?? "");
  const manifestText = await manifestObject?.text();
  const manifest = Schema.decodeUnknownSync(ClassicRecoveryManifestSchema)(
    JSON.parse(manifestText ?? "null"),
  );
  await command("/classic-write", userId, {
    classicNodes: [
      { ...manifest.nodes[0]!, parentId: null, prevSiblingId: classic.id },
    ],
  });
  const before = await command<Inspection>("/inspect", userId);
  const collision = await mf.dispatchFetch("http://fixture/run", {
    method: "POST",
    body: JSON.stringify({
      userId,
      operation: "recover-classic",
      approvedManifestHash: preserved.recoveryManifestHash,
    }),
  });
  expect(collision.status).toBe(409);
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    before.classic.nodes,
  );
  await bucket.put(preserved.recoveryManifestKey ?? "", "{corrupt-json");
  const corrupt = await mf.dispatchFetch("http://fixture/run", {
    method: "POST",
    body: JSON.stringify({
      userId,
      operation: "recover-classic",
      approvedManifestHash: preserved.recoveryManifestHash,
    }),
  });
  expect(corrupt.status).toBe(409);
  const error = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.String }),
  )(await corrupt.json());
  expect(error.error).toContain("is not JSON");
  expect((await command<Inspection>("/inspect", userId)).classic.nodes).toEqual(
    before.classic.nodes,
  );

  const archiveUserId = randomUUID();
  await command("/seed", archiveUserId, {
    classicNodes: [node("Classic archive corruption control")],
    lunoraNodes: [node("archived experimental")],
    preferenceEnabled: false,
  });
  const interrupted = await command<RetirementRecord>("/run", archiveUserId, {
    operation: "preserve-classic",
    fault: "preserve-ack",
  });
  expect(interrupted.state).toBe("uncertain");
  await bucket.put(interrupted.lunoraSnapshotKey ?? "", "{corrupt-json");
  const archiveRetry = await command<RetirementRecord>("/run", archiveUserId, {
    operation: "retry",
  });
  expect(archiveRetry).toMatchObject({
    state: "uncertain",
    result: "operator-recovery-required",
  });
  expect(archiveRetry.failureReason).toContain("is not JSON");
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
  "migrate-with-recovery",
  "repair-classic",
  "retry",
  "dry-run",
  "preserve-classic",
  "recover-classic",
] satisfies Input["operation"][]) {
  test(`rejects overlapping ${operation} before any backend call`, async () => {
    const { userId, lunoraNodes } = await seed();
    const raced = await command<
      Inspection & {
        migration: RetirementRecord;
        rejected: boolean;
        backendCalls: number;
      }
    >("/race", userId, { operation, approvedManifestHash: "a".repeat(64) });
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
