import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { Effect } from "effect";
        import worker from "./worker/index";
        import { readMembership } from "./worker/membership";
        export default { async fetch(request, env, ctx) {
          const query = request.headers.get("x-fail-query");
          const prepare = env.DB.prepare.bind(env.DB);
          const DB = query ? {
            prepare(sql) {
              if (sql.includes(query)) {
                if (request.headers.get("x-fail-mode") === "reject")
                  return prepare("SELECT * FROM private_storage_outage");
                throw new Error("private D1 outage details");
              }
              return prepare(sql);
            },
            batch: env.DB.batch.bind(env.DB),
            exec: env.DB.exec.bind(env.DB),
          } : env.DB;
          if (new URL(request.url).pathname === "/__membership-result")
            return Response.json(await Effect.runPromise(
              Effect.result(readMembership(DB, "member"))));
          return worker.fetch(request, { ...env, DB }, ctx);
        } };
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:*", "node:*"],
    target: "es2022",
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("Missing membership test bundle");
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "membership-test",
          compatibilityDate: "2026-06-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": { type: "esm", contents: output.text },
            },
          },
          env: {
            DB: { type: "d1", id: "membership-db" },
            BETTER_AUTH_SECRET: {
              type: "text",
              value: "disposable-membership-test-secret",
            },
            BETTER_AUTH_URL: { type: "text", value: "http://fixture" },
            SIGNUP_OPEN: { type: "text", value: "true" },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  for (const migration of [
    "0003_create_auth.sql",
    "0004_create_oauth.sql",
    "0006_create_stripe.sql",
    "0017_membership_welcome.sql",
    "0021_pro_trial_checkout.sql",
    "0022_pro_rewards.sql",
  ]) {
    const sql = await Bun.file(
      new URL(`../migrations/${migration}`, import.meta.url),
    ).text();
    await db.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
  }
});

afterAll(async () => {
  await mf?.dispose();
});

test("membership reads retain typed storage failures, GET sanitizes them to 503, and projection defects remain 500", async () => {
  const authRequest = (action: string) =>
    mf.dispatchFetch(`http://fixture/api/auth/${action}/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://fixture",
      },
      body: JSON.stringify({
        name: "Member",
        email: "member@example.test",
        password: "disposable-password-123",
      }),
    });
  const signup = await authRequest("sign-up");
  expect(signup.status).toBe(200);
  await db.exec("UPDATE user SET emailVerified=1");
  const signin = await authRequest("sign-in");
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).not.toBe("");
  const membership = (query?: string, mode = "throw") =>
    mf.dispatchFetch("http://fixture/api/membership", {
      headers: query
        ? { cookie, "x-fail-query": query, "x-fail-mode": mode }
        : { cookie },
    });

  const healthy = await membership();
  expect(healthy.status).toBe(200);
  expect(await healthy.json()).toMatchObject({
    plan: "free",
    giftEndsAt: null,
    rewardMessage: null,
    trialEligible: true,
    subs: [],
    welcome: null,
  });

  // Each projection read must remain recoverable, including the legacy reads.
  for (const [query, tag] of [
    ["SELECT plan, status", "MembershipStorageError"],
    ["SELECT plan FROM subscription", "MembershipStorageError"],
    ["SELECT MIN(startsAt)", "RewardStorageError"],
    ["SELECT message FROM pro_reward", "MembershipStorageError"],
    ["SELECT w.id, w.plan", "MembershipStorageError"],
    ["SELECT id FROM user WHERE", "MembershipStorageError"],
  ]) {
    for (const mode of ["throw", "reject"]) {
      const typed = await mf.dispatchFetch(
        "http://fixture/__membership-result",
        {
          headers: { "x-fail-query": query, "x-fail-mode": mode },
        },
      );
      expect(typed.status).toBe(200);
      expect(await typed.json()).toMatchObject({
        _tag: "Failure",
        failure: { _tag: tag },
      });
      const response = await membership(query, mode);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toEqual({
        error: "Membership storage is unavailable. Retry in a moment.",
      });
      expect(JSON.stringify(body)).not.toContain("private D1 outage details");
    }
  }

  // A bad stored date throws during projection, outside the D1 error adapter.
  await db
    .prepare(`INSERT INTO subscription (id,plan,referenceId,status,trialEnd)
      SELECT 'broken-date','unlimited',id,'active','not-a-date' FROM user`)
    .run();
  const defect = await membership();
  expect(defect.status).toBe(500);
  expect(await defect.json()).toEqual({ error: "internal error" });
  await db.exec("DELETE FROM subscription WHERE id='broken-date'");
  expect((await membership()).status).toBe(200);
});
