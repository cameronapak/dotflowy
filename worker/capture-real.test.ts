import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type {
  CaptureBody,
  CaptureReceipt,
  CaptureResult,
} from "./capture-input";
import type { CaptureKeyEntry } from "./capture-keys";
import type { FixtureInput } from "./capture-real-fixture";

let mf: Miniflare;
let directory: string;

type Key = { key: string; entry: { id: string; suffix: string } };
type Inspection = {
  snapshot: OutlineSnapshot;
  keys: Array<CaptureKeyEntry & { hash: string }>;
};

async function fixture<A = unknown>(
  path: string,
  input: FixtureInput,
): Promise<A> {
  const { response, body } = await fixtureResponse<A>(path, input);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function fixtureResponse<A = unknown>(path: string, input: FixtureInput) {
  const response = await mf.dispatchFetch(`http://fixture/fixture/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  // SAFETY: The test-owned fixture routes return the contract chosen at each call site.
  return { response, body: (await response.json()) as A };
}

async function api(path: string, key: string, body?: typeof CaptureBody.Type) {
  const headers = new Headers({ authorization: `Bearer ${key}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await mf.dispatchFetch(`http://fixture${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: Object.fromEntries(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // SAFETY: Capture returns receipt fields on success, error/message on failure;
  // other endpoints are used only to assert status and may return non-JSON.
  const result = (await response.json().catch(() => null)) as Partial<
    CaptureReceipt & { replayed: boolean; error: string; message: string }
  > | null;
  return {
    response,
    body: result,
  };
}

async function account() {
  const userId = randomUUID();
  await fixture("seed", { userId });
  const created = await fixture<Key>("key", { userId });
  return { userId, ...created };
}

function assertSiblingChains(nodes: readonly Node[]) {
  const byParent = new Map<string | null, Node[]>();
  for (const node of nodes)
    byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  for (const siblings of byParent.values()) {
    expect(siblings.filter((node) => node.prevSiblingId === null)).toHaveLength(
      1,
    );
    const ids = new Set(siblings.map((node) => node.id));
    expect(
      siblings
        .filter((node) => node.prevSiblingId !== null)
        .every((node) => ids.has(node.prevSiblingId!)),
    ).toBe(true);
    const seen = new Set<string>();
    let current = siblings.find((node) => node.prevSiblingId === null)!;
    while (current) {
      expect(seen.has(current.id)).toBe(false);
      seen.add(current.id);
      const next = siblings.find((node) => node.prevSiblingId === current.id);
      if (!next) break;
      current = next;
    }
    expect(seen.size).toBe(siblings.length);
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dotflowy-capture-"));
  const scriptPath = join(directory, "worker.mjs");
  await build({
    entryPoints: ["worker/capture-real-worker.ts"],
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
          name: "capture-test",
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
              worker: "capture-test",
              exportName: "UserOutlineDO",
            },
            SHARD: {
              type: "durable-object",
              worker: "capture-test",
              exportName: "ShardDO",
            },
            DB: { type: "d1", id: "capture-db" },
            BACKUPS: { type: "r2", name: "capture-backups" },
            CAPTURE_LIMIT: {
              type: "rate-limit",
              namespace: "1003",
              simple: { limit: 60, period: 60 },
            },
            UNFURL_LIMIT: {
              type: "rate-limit",
              namespace: "1004",
              simple: { limit: 1, period: 60 },
            },
            BETTER_AUTH_SECRET: {
              type: "text",
              value: "disposable-capture-test-secret-not-for-production",
            },
            BETTER_AUTH_URL: { type: "text", value: "http://fixture" },
            SIGNUP_OPEN: { type: "text", value: "true" },
            OWNER_USER_ID: { type: "text", value: "nobody-is-the-owner" },
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
    "0004_create_oauth.sql",
    "0006_create_stripe.sql",
    "0014_capture_keys.sql",
  ]) {
    const sql = await readFile(`migrations/${migration}`, "utf8");
    await db.exec(sql.replace(/^--.*$/gm, "").replaceAll("\n", " "));
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("free-account HTTP capture honors explicit date and has decisive idempotency", async () => {
  const { userId, key } = await account();
  const attemptId = randomUUID();
  const payload = { attemptId, date: "2024-02-29", text: "same attempt" };
  const [left, right] = await Promise.all([
    api("/api/capture", key, payload),
    api("/api/capture", key, payload),
  ]);
  expect([left.response.status, right.response.status]).toEqual([200, 200]);
  expect(new Set([left.body!.nodeId, right.body!.nodeId]).size).toBe(1);
  expect([left.body!.replayed, right.body!.replayed].sort()).toEqual([
    false,
    true,
  ]);

  const fresh = await api("/api/capture", key, {
    ...payload,
    attemptId: randomUUID(),
  });
  expect(fresh.response.status).toBe(200);
  expect(fresh.body!.nodeId).not.toBe(left.body!.nodeId);
  const conflict = await api("/api/capture", key, {
    ...payload,
    text: "changed",
  });
  expect(conflict.response.status).toBe(409);

  const { snapshot } = await fixture<Inspection>("inspect", { userId });
  expect(
    snapshot.nodes.filter((node) => node.text === "same attempt"),
  ).toHaveLength(2);
  const daily = snapshot.kv.filter((row) => row.collection === "daily-index");
  expect(daily.filter((row) => row.key === "2024-02-29")).toHaveLength(1);
  expect(daily.map((row) => row.key).sort()).toEqual([
    "2024",
    "2024-02",
    "2024-02-29",
    "container",
    "week:2024-02-26",
  ]);
});

test("concurrent distinct captures make one scaffold and a valid sibling chain", async () => {
  const { userId, key } = await account();
  const requests = Array.from({ length: 8 }, (_, index) =>
    api("/api/capture", key, {
      attemptId: randomUUID(),
      date: "2026-10-03",
      text: `capture ${index}`,
    }),
  );
  const results = await Promise.all(requests);
  expect(results.every(({ response }) => response.status === 200)).toBe(true);
  const { snapshot } = await fixture<Inspection>("inspect", { userId });
  expect(
    snapshot.nodes.filter((node) => node.text.startsWith("capture ")),
  ).toHaveLength(8);
  expect(
    snapshot.kv.filter((row) => row.collection === "daily-index"),
  ).toHaveLength(5);
  assertSiblingChains(snapshot.nodes);
});

test("replay after user edit or deletion preserves that state", async () => {
  const { userId, key } = await account();
  const editedAttempt = randomUUID();
  const deletedAttempt = randomUUID();
  const first = await api("/api/capture", key, {
    attemptId: editedAttempt,
    date: "2026-09-01",
    text: "edit me",
  });
  const second = await api("/api/capture", key, {
    attemptId: deletedAttempt,
    date: "2026-09-01",
    text: "delete me",
  });
  await fixture("edit", {
    userId,
    nodeId: first.body!.nodeId,
    updatedText: "user edit",
  });
  await fixture("delete", { userId, nodeId: second.body!.nodeId });
  expect(
    (
      await api("/api/capture", key, {
        attemptId: editedAttempt,
        date: "2026-09-01",
        text: "edit me",
      })
    ).body!.replayed,
  ).toBe(true);
  expect(
    (
      await api("/api/capture", key, {
        attemptId: deletedAttempt,
        date: "2026-09-01",
        text: "delete me",
      })
    ).body!.replayed,
  ).toBe(true);
  const { snapshot } = await fixture<Inspection>("inspect", { userId });
  expect(
    snapshot.nodes.find((node) => node.id === first.body!.nodeId)?.text,
  ).toBe("user edit");
  expect(snapshot.nodes.some((node) => node.id === second.body!.nodeId)).toBe(
    false,
  );
});

test("quota refusal rolls back receipt and all scaffold rows", async () => {
  const { userId } = await account();
  const attemptId = randomUUID();
  const refused = await fixture<CaptureResult>("capture", {
    userId,
    attemptId,
    date: "2026-08-12",
    text: "over quota",
    limit: 5,
  });
  expect(refused).toEqual({ error: "node_limit" });
  let inspection = await fixture<Inspection>("inspect", { userId });
  expect(inspection.snapshot.nodes).toEqual([]);
  expect(inspection.snapshot.kv).toEqual([]);
  const retry = await fixture<{
    receipt: { nodeId: string };
    replayed: boolean;
  }>("capture", {
    userId,
    attemptId,
    date: "2026-08-12",
    text: "over quota",
    limit: 6,
  });
  expect(retry.replayed).toBe(false);
  inspection = await fixture<Inspection>("inspect", { userId });
  expect(
    inspection.snapshot.nodes.some((node) => node.id === retry.receipt.nodeId),
  ).toBe(true);
  expect(inspection.snapshot.nodes).toHaveLength(6);
});

test("title upgrade only changes the untouched captured node", async () => {
  const { userId } = await account();
  const untouched = randomUUID();
  const edited = randomUUID();
  const deleted = randomUUID();
  const a = await fixture<{ receipt: { nodeId: string } }>("capture", {
    userId,
    attemptId: untouched,
    date: "2026-07-01",
    text: "raw",
  });
  const b = await fixture<{ receipt: { nodeId: string } }>("capture", {
    userId,
    attemptId: edited,
    date: "2026-07-01",
    text: "raw edit",
  });
  const c = await fixture<{ receipt: { nodeId: string } }>("capture", {
    userId,
    attemptId: deleted,
    date: "2026-07-01",
    text: "raw delete",
  });
  await fixture("edit", {
    userId,
    nodeId: b.receipt.nodeId,
    updatedText: "mine",
  });
  await fixture("delete", { userId, nodeId: c.receipt.nodeId });
  expect(
    await fixture<{ upgraded: boolean }>("upgrade", {
      userId,
      attemptId: untouched,
      expected: "raw",
      updatedText: "title",
    }),
  ).toEqual({ upgraded: true });
  expect(
    await fixture<{ upgraded: boolean }>("upgrade", {
      userId,
      attemptId: edited,
      expected: "raw edit",
      updatedText: "bad",
    }),
  ).toEqual({ upgraded: false });
  expect(
    await fixture<{ upgraded: boolean }>("upgrade", {
      userId,
      attemptId: deleted,
      expected: "raw delete",
      updatedText: "bad",
    }),
  ).toEqual({ upgraded: false });
  const { snapshot } = await fixture<Inspection>("inspect", { userId });
  expect(
    snapshot.nodes.find((node) => node.id === a.receipt.nodeId)?.text,
  ).toBe("title");
  expect(
    snapshot.nodes.find((node) => node.id === b.receipt.nodeId)?.text,
  ).toBe("mine");
});

test("key storage, expiry boundary, revocation, tenant isolation, and password version fail closed", async () => {
  const first = await account();
  const second = await account();
  const exact = 2_000_000_000_000;
  const expiring = await fixture<Key>("key", {
    userId: first.userId,
    expiresAt: exact,
  });
  expect(
    await fixture<{ authenticated: boolean }>("auth", {
      userId: first.userId,
      authorization: `Bearer ${expiring.key}`,
      now: exact - 1,
    }),
  ).toEqual({ authenticated: true });
  expect(
    await fixture<{ authenticated: boolean }>("auth", {
      userId: first.userId,
      authorization: `Bearer ${expiring.key}`,
      now: exact,
    }),
  ).toEqual({ authenticated: false });
  const inspection = await fixture<Inspection>("inspect", {
    userId: first.userId,
  });
  expect(JSON.stringify(inspection.keys)).not.toContain(first.key);
  expect(inspection.keys[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  const listed = await fixture<{ keys: unknown[] }>("manage", {
    userId: first.userId,
    manageMethod: "GET",
  });
  expect(JSON.stringify(listed)).not.toContain(first.key);

  await fixture("manage", {
    userId: second.userId,
    manageMethod: "DELETE",
    manageBody: { id: first.entry.id },
  });
  expect(
    (
      await api("/api/capture", first.key, {
        attemptId: randomUUID(),
        date: "2026-01-01",
        text: "still valid",
      })
    ).response.status,
  ).toBe(200);
  await fixture("manage", {
    userId: first.userId,
    manageMethod: "DELETE",
    manageBody: { id: first.entry.id },
  });
  expect(
    (
      await api("/api/capture", first.key, {
        attemptId: randomUUID(),
        date: "2026-01-01",
        text: "revoked",
      })
    ).response.status,
  ).toBe(401);
  await fixture("manage", {
    userId: second.userId,
    manageMethod: "DELETE",
    manageBody: {},
  });
  expect(
    (
      await api("/api/capture", second.key, {
        attemptId: randomUUID(),
        date: "2026-01-01",
        text: "revoked all",
      })
    ).response.status,
  ).toBe(401);

  const replacement = await fixture<Key>("key", { userId: first.userId });
  await fixture("password", { userId: first.userId, password: "password-v2" });
  expect(
    (
      await api("/api/capture", replacement.key, {
        attemptId: randomUUID(),
        date: "2026-01-01",
        text: "stale key",
      })
    ).response.status,
  ).toBe(401);
});

test("real password change and reset revoke keys; sign-out does not", async () => {
  const email = `${randomUUID()}@capture.test`;
  const password = "disposable-test-password-1";
  type AuthBody = {
    name?: string;
    email?: string;
    password?: string;
    currentPassword?: string;
    newPassword?: string;
    redirectTo?: string;
    token?: string;
  };
  const auth = (path: string, body: AuthBody, cookie?: string) => {
    const headers = new Headers({
      "content-type": "application/json",
      origin: "http://fixture",
    });
    if (cookie) headers.set("cookie", cookie);
    return mf.dispatchFetch(`http://fixture/api/auth/${path}`, {
      method: "POST",
      headers: Object.fromEntries(headers),
      body: JSON.stringify(body),
    });
  };
  const signup = await auth("sign-up/email", {
    name: "Capture test",
    email,
    password,
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const db = await mf.getD1Database("DB");
  const user = await db
    .prepare('SELECT id FROM "user" WHERE email=?')
    .bind(email)
    .first<{ id: string }>();
  expect(user).not.toBeNull();
  const userId = user!.id;
  await db
    .prepare('UPDATE "user" SET emailVerified=1 WHERE id=?')
    .bind(userId)
    .run();
  const signin = await auth("sign-in/email", { email, password });
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const first = await fixture<Key>("key", { userId });
  const refused = await auth(
    "change-password",
    {
      currentPassword: "incorrect-password",
      newPassword: "disposable-test-password-2",
    },
    cookie,
  );
  expect(refused.status).not.toBe(200);
  expect((await fixture<Inspection>("inspect", { userId })).keys).toHaveLength(
    1,
  );
  const changed = await auth(
    "change-password",
    { currentPassword: password, newPassword: "disposable-test-password-2" },
    cookie,
  );
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect((await fixture<Inspection>("inspect", { userId })).keys).toHaveLength(
    0,
  );
  expect(
    await fixture<{ authenticated: boolean }>("auth", {
      userId,
      authorization: `Bearer ${first.key}`,
    }),
  ).toEqual({ authenticated: false });

  const second = await fixture<Key>("key", { userId });
  const signedOut = await auth("sign-out", {}, cookie);
  expect(signedOut.status).toBe(200);
  expect(
    await fixture<{ authenticated: boolean }>("auth", {
      userId,
      authorization: `Bearer ${second.key}`,
    }),
  ).toEqual({ authenticated: true });
  const requested = await auth("request-password-reset", {
    email,
    redirectTo: "http://fixture/reset-password",
  });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const token = await db
    .prepare(
      "SELECT identifier FROM verification WHERE value=? AND identifier LIKE 'reset-password:%'",
    )
    .bind(userId)
    .first<{ identifier: string }>();
  expect(token).not.toBeNull();
  const reset = await auth("reset-password", {
    token: token!.identifier.slice("reset-password:".length),
    newPassword: "disposable-test-password-3",
  });
  expect(reset.status, await reset.clone().text()).toBe(200);
  expect((await fixture<Inspection>("inspect", { userId })).keys).toHaveLength(
    0,
  );
  expect(
    await fixture<{ authenticated: boolean }>("auth", {
      userId,
      authorization: `Bearer ${second.key}`,
    }),
  ).toEqual({ authenticated: false });
});

test("capture key is scoped away from every other production API", async () => {
  const { key } = await account();
  for (const path of [
    "/mcp",
    "/api/nodes",
    "/api/kv?collection=daily-index",
    "/api/capture-keys",
  ]) {
    const { response } = await api(path, key);
    expect(response.status, path).toBe(401);
  }
});

test("invalid capture input creates no nodes; key management enforces origin and freshness", async () => {
  const { userId, key } = await account();
  for (const body of [
    { attemptId: randomUUID(), date: "2026-02-30", text: "impossible" },
    { attemptId: randomUUID(), date: "2026-1-01", text: "malformed" },
    { attemptId: randomUUID(), date: "2026-01-01", text: " \n " },
  ])
    expect((await api("/api/capture", key, body)).response.status).toBe(400);
  expect(
    (await fixture<Inspection>("inspect", { userId })).snapshot.nodes,
  ).toEqual([]);

  const malformedRevoke = await fixtureResponse("manage", {
    userId,
    manageMethod: "DELETE",
    manageBody: { ids: ["typo"] },
  });
  expect(malformedRevoke.response.status).toBe(400);
  expect((await fixture<Inspection>("inspect", { userId })).keys).toHaveLength(
    1,
  );

  const badOrigin = await fixtureResponse<{ error: string }>("manage", {
    userId,
    manageMethod: "POST",
    manageBody: { name: "bad", expiry: "never" },
    origin: "https://evil.test",
  });
  expect(badOrigin.response.status).toBe(403);
  expect(badOrigin.body.error).toBe("invalid_origin");
  const stale = await fixtureResponse<{ error: string }>("manage", {
    userId,
    manageMethod: "POST",
    manageBody: { name: "old", expiry: "never" },
    sessionCreatedAt: Date.now() - 86_400_000,
  });
  expect(stale.response.status).toBe(401);
  expect(stale.body.error).toBe("fresh_session_required");
  const fresh = await fixtureResponse<Key>("manage", {
    userId,
    manageMethod: "POST",
    manageBody: { name: "fresh", expiry: "never" },
    sessionCreatedAt: Date.now(),
  });
  expect(fresh.response.status).toBe(201);
  expect(fresh.body.key).toMatch(/^dfc_[0-9a-f]{64}$/);
});
