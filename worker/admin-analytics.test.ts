import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import {
  AdminAnalyticsReport,
  type ClassicAnalyticsMetadata,
} from "../src/data/admin-analytics-schema";
import { handleAdminAnalytics } from "./admin-analytics";

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86_400_000;
const admin = { user: { id: "admin", email: "admin@example.test" } };
type Env = Parameters<typeof handleAdminAnalytics>[1];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Execute the handler's actual SQL against disposable SQLite, not canned rows. */
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT,
    createdAt DATE, emailVerified INTEGER);
    CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT, createdAt DATE);`);
  const routed: string[] = [];
  const shardCalls: { headers: Headers; body: unknown }[] = [];
  let prepared = 0;
  let active = 0;
  let peak = 0;
  const broken = new Set<string>();
  const metadata = new Map<string, ClassicAnalyticsMetadata>();
  const env: Env = {
    ADMIN_USER_IDS: "admin",
    OWNER_USER_ID: "a-owner",
    // SAFETY: the D1 adapter implements exactly prepare/bind/first/all, the
    // read-only surface this handler uses. Unimplemented D1 APIs stay absent.
    DB: {
      prepare(sql: string) {
        prepared++;
        let args: SQLQueryBindings[] = [];
        return {
          bind(...values: SQLQueryBindings[]) {
            args = values;
            return this;
          },
          async first() {
            return db.query(sql).get(...args);
          },
          async all() {
            return { results: db.query(sql).all(...args) };
          },
        };
      },
    } as Env["DB"],
    USER_OUTLINE: {
      // SAFETY: the fake DO id carries its routing name; get reads that name.
      idFromName: (name) => ({ name }) as DurableObjectId,
      get: (id) => ({
        async getAnalyticsMetadata() {
          const name = id.name ?? "";
          routed.push(name);
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          if (broken.has(name)) throw new Error("unavailable");
          return (
            metadata.get(name) ?? {
              nodeCount: 0,
              experimentalPreference: "unset",
            }
          );
        },
      }),
    },
    SHARD: {
      idFromName: (name) => name,
      get: () => ({
        async fetch(request: Request) {
          shardCalls.push({
            headers: request.headers,
            body: await request.json(),
          });
          return Response.json({
            result: { nodeCount: 17, nodesMigratedAt: 1, kvMigratedAt: null },
          });
        },
      }),
    },
  };
  function user(id: string, at = NOW) {
    db.query('INSERT INTO "user" VALUES (?, ?, ?, ?, 1)').run(
      id,
      `${id}@example.test`,
      id,
      new Date(at).toISOString(),
    );
  }
  function session(id: string, userId: string, at: number) {
    db.query('INSERT INTO "session" VALUES (?, ?, ?)').run(
      id,
      userId,
      new Date(at).toISOString(),
    );
  }
  const request = (
    path = "",
    method = "GET",
    identity: typeof admin | null = admin,
  ) =>
    Effect.runPromise(
      handleAdminAnalytics(
        new Request(`https://app.example.test/api/admin/analytics${path}`, {
          method,
        }),
        env,
        identity,
        NOW,
      ),
    );
  async function report(path = "") {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return Schema.decodeUnknownSync(AdminAnalyticsReport)(
      await response.json(),
    );
  }
  return {
    env,
    user,
    session,
    request,
    report,
    routed,
    shardCalls,
    broken,
    metadata,
    prepared: () => prepared,
    peak: () => peak,
  };
}

describe("admin analytics", () => {
  test("denies before methods, validation, D1, or tenant inspection", async () => {
    const f = fixture();
    for (const path of ["?includeOwner=garbage", "/storage?userId=anything"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        for (const identity of [
          null,
          { user: { id: "other", email: admin.user.email } },
        ]) {
          const response = await f.request(path, method, identity);
          expect(response.status).toBe(404);
          expect(await response.json<unknown>()).toEqual({
            error: "not found",
          });
          expect(response.headers.get("cache-control")).toBe(
            "private, no-store",
          );
        }
      }
    }
    expect(f.prepared()).toBe(0);
    expect(f.routed).toEqual([]);
    expect(f.shardCalls).toEqual([]);
    delete f.env.ADMIN_USER_IDS;
    expect((await f.request()).status).toBe(404);
  });

  test("counts people, not sessions; tests both sides of 7/30-day boundaries", async () => {
    const f = fixture();
    f.user("a-owner", NOW);
    f.user("b", NOW - 7 * DAY);
    f.user("c", NOW - 7 * DAY - 1);
    f.user("d", NOW - 30 * DAY);
    f.user("e", NOW - 30 * DAY - 1);
    f.session("b-old", "b", NOW - 20 * DAY);
    f.session("b-new", "b", NOW - 7 * DAY);
    f.session("c", "c", NOW - 7 * DAY - 1);
    f.session("e", "e", NOW);
    const result = await f.report();
    expect(result.population).toBe(5);
    expect(result.users.find((u) => u.id === "b")?.createdAt).toBe(
      NOW - 7 * DAY,
    );
    expect(result.users.find((u) => u.id === "b")?.lastSessionCreatedAt).toBe(
      NOW - 7 * DAY,
    );
    expect(result.summary).toEqual({
      registered: 4,
      joined7d: 1,
      joined30d: 3,
      retainedSession7d: 2,
      retainedSession30d: 3,
    });
    expect(
      result.users.find((u) => u.id === "d")?.lastSessionCreatedAt,
    ).toBeNull();
    expect(result.users.find((u) => u.id === "a-owner")?.isOwner).toBe(true);
    expect(f.routed).toContain("default");
    expect(f.routed).not.toContain("a-owner");
    const included = await f.report("?includeOwner=true");
    expect(included.summary).toEqual({
      registered: 5,
      joined7d: 2,
      joined30d: 4,
      retainedSession7d: 2,
      retainedSession30d: 3,
    });
    expect(result.activityCoverage).toBe("not-installed");
    expect(f.shardCalls).toEqual([]);
  });

  test("unknown metadata stays unknown, and extra private fields cannot leave the decoder", async () => {
    const f = fixture();
    f.user("a");
    f.user("b");
    f.user("c");
    f.broken.add("a");
    const privateMetadata = {
      nodeCount: 3,
      experimentalPreference: "enabled" as const,
      text: "PRIVATE OUTLINE",
    };
    f.metadata.set("b", privateMetadata);
    f.metadata.set("c", { nodeCount: -1, experimentalPreference: "disabled" });
    const result = await f.report();
    expect(
      result.users.map((u) => [u.classicNodeCount, u.experimentalPreference]),
    ).toEqual([
      [null, "unknown"],
      [3, "enabled"],
      [null, "unknown"],
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE OUTLINE");
  });

  test("pages by stable ids, reads only 50 metadata rows, and bounds fanout", async () => {
    const f = fixture();
    for (let i = 0; i < 51; i++) f.user(`u${String(i).padStart(3, "0")}`);
    const first = await f.report();
    expect(first.users).toHaveLength(50);
    expect(first.nextCursor).toBe("u049");
    expect(f.routed).toHaveLength(50);
    expect(f.peak()).toBeLessThanOrEqual(8);
    const second = await f.report("?after=u049");
    expect(second.users.map((u) => u.id)).toEqual(["u050"]);
    expect(second.nextCursor).toBeNull();
    expect(second.summary.registered).toBe(51);
    expect(f.routed).toHaveLength(51);
  });

  test("validates admin input before reads and refuses arbitrary shard keys", async () => {
    const f = fixture();
    expect((await f.request("", "POST")).status).toBe(405);
    expect((await f.request("?includeOwner=yes")).status).toBe(400);
    expect((await f.request(`?after=${"x".repeat(201)}`)).status).toBe(400);
    expect((await f.request("/storage")).status).toBe(400);
    expect(f.prepared()).toBe(0);
    expect((await f.request("/storage?userId=missing")).status).toBe(404);
    expect(f.shardCalls).toEqual([]);
    // A cursor is a bound value, not executable SQL.
    expect((await f.report("?after=%27%20OR%201%3D1%20--")).users).toEqual([]);
  });

  test("inspects an existing user's shard only as system and returns no outline rows", async () => {
    const f = fixture();
    f.user("a-owner");
    const response = await f.request("/storage?userId=a-owner");
    expect(await response.json<unknown>()).toEqual({
      userId: "a-owner",
      checkedAt: NOW,
      metadata: { nodeCount: 17, nodesMigratedAt: 1, kvMigratedAt: null },
    });
    expect(f.shardCalls).toHaveLength(1);
    expect(f.shardCalls[0]?.headers.get("x-lunora-system")).toBe("1");
    expect(f.shardCalls[0]?.headers.get("x-lunora-userid")).toBeNull();
    expect(f.shardCalls[0]?.body).toMatchObject({
      functionPath: "admin:outlineMetadata",
      args: { userId: "a-owner" },
    });
  });

  test("empty population has real zero account totals, not zero activity", async () => {
    const result = await fixture().report();
    expect(result.population).toBe(0);
    expect(result.summary).toEqual({
      registered: 0,
      joined7d: 0,
      joined30d: 0,
      retainedSession7d: 0,
      retainedSession30d: 0,
    });
    expect(result.users).toEqual([]);
    expect(result.activityCoverage).toBe("not-installed");
  });
});
