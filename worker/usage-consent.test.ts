import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";

import { USAGE_POLICY_VERSION } from "../src/data/usage-consent-schema";
import {
  captureUsageGeneration,
  handleUsageConsent,
  oldestUsageDay,
  purgeUsageSummaries,
  recordUsagePresence,
} from "./usage-consent";

const NOW = Date.UTC(2026, 9, 2, 12);
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
type Env = Parameters<typeof handleUsageConsent>[1];
type SQLiteStatement = { sql: string; args: SQLQueryBindings[] };

async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    'PRAGMA foreign_keys = ON; CREATE TABLE "user" (id TEXT PRIMARY KEY);',
  );
  db.exec(
    await Bun.file(
      new URL("../migrations/0012_usage_consent.sql", import.meta.url),
    ).text(),
  );
  db.exec("INSERT INTO \"user\" VALUES ('owner'), ('other');");
  let readsFail = false;
  let erasureFails = false;
  let prepared = 0;
  const statements = new WeakMap<object, SQLiteStatement>();
  // SAFETY: executes the module's actual SQL; D1 results expose the real SQLite
  // changes count. Unused D1 result metadata and APIs are intentionally absent.
  const DB = {
    prepare(sql: string) {
      prepared++;
      if (readsFail) throw new Error("D1 unavailable");
      const entry: SQLiteStatement = {
        sql,
        args: [],
      };
      const statement = {
        bind(...args: SQLQueryBindings[]) {
          entry.args = args;
          return this;
        },
        async first() {
          return db.query(sql).get(...entry.args);
        },
        async all() {
          return { results: db.query(sql).all(...entry.args) };
        },
        async run() {
          return {
            success: true,
            meta: { changes: db.query(sql).run(...entry.args).changes },
          };
        },
      };
      statements.set(statement, entry);
      return statement;
    },
    async batch(batch: D1PreparedStatement[]) {
      return db.transaction(() =>
        batch.map((statement) => {
          const entry = statements.get(statement);
          if (!entry) throw new Error("Unknown statement");
          if (erasureFails && entry.sql.startsWith("DELETE"))
            throw new Error("Erasure unavailable");
          return {
            success: true,
            meta: { changes: db.query(entry.sql).run(...entry.args).changes },
          };
        }),
      )();
    },
  } as Env["DB"];
  const env: Env = {
    DB,
    USAGE_NOTICE_VERSION: USAGE_POLICY_VERSION,
  };
  function request(
    path = "consent",
    init?: RequestInit,
    userId: string | null = "owner",
  ) {
    return Effect.runPromise(
      handleUsageConsent(
        new Request(`https://app.example.test/api/usage/${path}`, init),
        env,
        userId,
        NOW,
      ),
    );
  }
  function choice(value: "accepted" | "declined", userId = "owner") {
    return request(
      "consent",
      {
        method: "POST",
        headers: {
          origin: "https://app.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          policyVersion: USAGE_POLICY_VERSION,
          choice: value,
        }),
      },
      userId,
    );
  }
  const capture = (userId = "owner") =>
    Effect.runPromise(captureUsageGeneration(env, userId));
  const record = (
    generation: string,
    day = "2026-10-02",
    userId = "owner",
    backend: "classic" | "experimental" = "classic",
  ) =>
    Effect.runPromise(
      recordUsagePresence(
        env,
        userId,
        generation,
        { day, backend, source: "browser", activity: "edited" },
        NOW,
      ),
    );
  const rows = () =>
    db.query("SELECT * FROM usage_daily ORDER BY userId, day, backend").all();
  return {
    db,
    env,
    request,
    choice,
    capture,
    record,
    rows,
    failReads: () => {
      readsFail = true;
    },
    failErasure: () => {
      erasureFails = true;
    },
    prepared: () => prepared,
  };
}

test("publication gate is exact, never enables collection, and decline remains available", async () => {
  const f = await fixture();
  for (const version of [undefined, "true", "2026-10-02 ", "2026-10-01"]) {
    f.env.USAGE_NOTICE_VERSION = version;
    expect((await f.choice("accepted")).status).toBe(409);
    expect(await f.capture()).toBeNull();
  }
  expect(f.db.query("SELECT * FROM usage_consent").all()).toHaveLength(0);
  expect((await f.choice("declined")).status).toBe(200);
  const state: unknown = await (await f.request()).json();
  expect(state).toEqual({
    policyVersion: USAGE_POLICY_VERSION,
    choice: "declined",
    decidedAt: NOW,
    noticeAvailable: false,
    collectionInstalled: false,
  });
  f.env.USAGE_NOTICE_VERSION = USAGE_POLICY_VERSION;
  expect((await f.choice("accepted")).status).toBe(200);
  expect(await f.capture()).toBeString();
  expect(f.rows()).toHaveLength(0); // accepting does not produce activity
});

test("auth, method, CSRF, schema, and content type checks precede storage writes", async () => {
  const f = await fixture();
  expect(
    (await f.request("consent", { method: "POST", body: "bad" }, null)).status,
  ).toBe(401);
  expect(f.prepared()).toBe(0);
  expect((await f.request("consent", { method: "DELETE" })).status).toBe(405);
  expect((await f.request("export", { method: "POST" })).status).toBe(405);
  for (const origin of [undefined, "https://evil.example", "null"]) {
    expect(
      (
        await f.request("consent", {
          method: "POST",
          headers: origin ? { origin } : {},
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await f.request("consent", {
        method: "POST",
        headers: {
          origin: "https://app.example.test",
          "sec-fetch-site": "cross-site",
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("consent", {
        method: "POST",
        headers: { origin: "https://app.example.test" },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  for (const body of [
    "bad",
    "{}",
    '{"choice":"yes"}',
    JSON.stringify({ choice: "accepted", policyVersion: "old" }),
    JSON.stringify({
      choice: "accepted",
      policyVersion: USAGE_POLICY_VERSION,
      userId: "other",
    }),
  ]) {
    expect(
      (
        await f.request("consent", {
          method: "POST",
          headers: {
            origin: "https://app.example.test",
            "content-type": "application/json",
          },
          body,
        })
      ).status,
    ).toBe(400);
  }
  expect(f.prepared()).toBe(0);
});

test("missing, old, malformed, declined, and failed consent reads suppress capture", async () => {
  const f = await fixture();
  expect(await f.capture()).toBeNull();
  await f.choice("declined");
  expect(await f.capture()).toBeNull();
  await f.choice("accepted");
  f.db.exec("UPDATE usage_consent SET policyVersion = 'old'");
  expect(await f.capture()).toBeNull();
  expect(await (await f.request()).json()).toMatchObject({
    choice: "unset",
    decidedAt: null,
  });
  f.db
    .query("UPDATE usage_consent SET policyVersion = ?, generation = ''")
    .run(USAGE_POLICY_VERSION);
  expect(await f.capture()).toBeNull();
  expect((await f.request()).status).toBe(503);
  f.failReads();
  expect(await f.capture()).toBeNull();
  const response = await f.request();
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body: unknown = await response.json();
  expect(body).toEqual({
    error: "usage settings unavailable",
  });
});

test("delivery before withdrawal is erased; delivery after withdrawal cannot recreate it", async () => {
  const f = await fixture();
  await f.choice("accepted");
  const generation = await f.capture();
  expect(generation).toBeString();
  await f.record(generation!);
  await f.record(generation!); // at-least-once attempts do not multiply presence
  await f.record(generation!, "2026-10-02", "owner", "experimental");
  expect(f.rows()).toHaveLength(2);
  await f.choice("declined");
  expect(f.rows()).toHaveLength(0);
  await f.record(generation!);
  expect(f.rows()).toHaveLength(0);
  // Same-millisecond reacceptance is deliberately not ordered by timestamps.
  await f.choice("accepted");
  const next = await f.capture();
  expect(next).not.toBe(generation);
  await f.record(generation!);
  expect(f.rows()).toHaveLength(0);
  await f.record(next!);
  expect(f.rows()).toHaveLength(1);
});

test("erasure failure rolls the generation and choice back as well as summaries", async () => {
  const f = await fixture();
  await f.choice("accepted");
  const generation = await f.capture();
  await f.record(generation!);
  f.failErasure();
  expect((await f.choice("declined")).status).toBe(503);
  expect(await f.capture()).toBe(generation);
  expect(f.rows()).toHaveLength(1);
});

test("account isolation, content-free export, and cascading deletion reject late delivery", async () => {
  const f = await fixture();
  await f.choice("accepted");
  await f.choice("accepted", "other");
  const generation = await f.capture();
  const other = await f.capture("other");
  await f.record(generation!, "2026-10-02", "other"); // cannot reuse a foreign generation
  expect(f.rows()).toHaveLength(0);
  await f.record(generation!);
  await f.record(other!, "2026-10-01", "other");
  const response = await f.request("export?userId=other");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const exported: unknown = await response.json();
  expect(exported).toEqual({
    consent: {
      policyVersion: USAGE_POLICY_VERSION,
      choice: "accepted",
      decidedAt: NOW,
    },
    daily: [
      {
        day: "2026-10-02",
        backend: "classic",
        source: "browser",
        activity: "edited",
      },
    ],
  });
  await f.choice("declined");
  expect(f.rows()).toHaveLength(1);
  f.db.exec("DELETE FROM \"user\" WHERE id = 'other'");
  expect(
    f.db.query("SELECT * FROM usage_consent WHERE userId = 'other'").all(),
  ).toHaveLength(0);
  expect(f.rows()).toHaveLength(0);
  await f.record(other!, "2026-10-01", "other");
  expect(f.rows()).toHaveLength(0);
});

test("90 UTC-day retention includes the boundary, rejects stale/future delivery, and purges old rows", async () => {
  const f = await fixture();
  expect(oldestUsageDay(NOW)).toBe("2026-07-05");
  expect(oldestUsageDay(Date.UTC(2026, 9, 2, 23, 59, 59))).toBe("2026-07-05");
  expect(oldestUsageDay(Date.UTC(2026, 9, 3))).toBe("2026-07-06");
  await f.choice("accepted");
  const generation = await f.capture();
  await f.record(generation!, "2026-07-04");
  await f.record(generation!, "2026-07-05");
  await f.record(generation!, "2026-10-03");
  expect(f.rows()).toHaveLength(1);
  f.db.exec(
    "INSERT INTO usage_daily VALUES ('owner', '2026-07-04', 'classic', 'mcp', 'edited')",
  );
  await Effect.runPromise(purgeUsageSummaries(f.env, NOW));
  expect(f.rows()).toEqual([
    {
      userId: "owner",
      day: "2026-07-05",
      backend: "classic",
      source: "browser",
      activity: "edited",
    },
  ]);
  expect(() =>
    f.db.exec(
      "INSERT INTO usage_daily VALUES ('owner', '2026-10-02', 'classic', 'mcp', 'opened')",
    ),
  ).toThrow();
});
