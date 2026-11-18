import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { Effect, Schema } from "effect";

import { RewardResult } from "../src/data/pro-reward";
import {
  giftCheckoutParams,
  giftWindow,
  handleRewards,
  reconcileMembershipCheckout,
  reconcileRewards,
} from "./pro-reward";

interface QueryHooks {
  beforeQuery?: (query: string) => void;
  afterCodeLookup?: () => Promise<void>;
}
interface CodeCommand {
  action: string;
  id: string;
  reason?: string;
}

async function rewardsFixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE user(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER,stripeCustomerId TEXT);
    CREATE TABLE feedback_submissions(id INTEGER PRIMARY KEY);
    CREATE TABLE subscription(
      id TEXT,plan TEXT,referenceId TEXT,status TEXT,stripeSubscriptionId TEXT,
      periodStart INTEGER,periodEnd INTEGER,trialStart INTEGER,trialEnd INTEGER,
      cancelAtPeriodEnd INTEGER,cancelAt INTEGER,canceledAt INTEGER,endedAt INTEGER,billingInterval TEXT
    );
  `);
  for (const migration of [
    "0021_pro_trial_checkout.sql",
    "0022_pro_rewards.sql",
  ])
    sql.exec(
      await Bun.file(
        new URL(`../migrations/${migration}`, import.meta.url),
      ).text(),
    );
  sql.exec(
    "INSERT INTO user VALUES ('recipient','recipient@fixture.test',1,NULL),('admin','admin@fixture.test',1,NULL)",
  );
  const hooks: QueryHooks = {};
  // SAFETY: this fixture implements the D1 prepare/bind/first/all/run surface
  // used by the public handler. SQLite executes the actual production SQL.
  const db = {
    prepare(query: string) {
      let args: SQLQueryBindings[] = [];
      const statement = {
        bind(...values: SQLQueryBindings[]) {
          args = values;
          return statement;
        },
        async first() {
          hooks.beforeQuery?.(query);
          const row = sql.query(query).get(...args);
          if (/SELECT\s+\*\s+FROM pro_reward WHERE codeHash\s*=/i.test(query)) {
            const afterLookup = hooks.afterCodeLookup;
            hooks.afterCodeLookup = undefined;
            await afterLookup?.();
          }
          return row;
        },
        async all() {
          hooks.beforeQuery?.(query);
          return { results: sql.query(query).all(...args) };
        },
        async run() {
          hooks.beforeQuery?.(query);
          return { meta: { changes: sql.query(query).run(...args).changes } };
        },
      };
      return statement;
    },
  } as D1Database;
  const env = { DB: db, ADMIN_USER_IDS: "admin" };
  const request = (
    path: string,
    body: string,
    admin = false,
  ): Promise<Response> =>
    Effect.runPromise(
      handleRewards(
        new Request(`https://fixture.test${path}`, {
          method: "POST",
          headers: {
            origin: "https://fixture.test",
            "content-type": "application/json",
          },
          body,
        }),
        env,
        {
          user: {
            id: admin ? "admin" : "recipient",
            email: admin ? "admin@fixture.test" : "recipient@fixture.test",
            emailVerified: true,
          },
        },
        admin,
      ),
    );
  const manage = (body: CodeCommand) =>
    request("/api/admin/pro-codes", JSON.stringify(body), true);
  const redeem = (code: string) =>
    request(
      "/api/membership/redeem",
      JSON.stringify({
        code,
        accountId: "recipient",
        consent: true,
      }),
    );
  async function issue() {
    const response = await manage({
      action: "create",
      id: crypto.randomUUID(),
      reason: "Fixed a reported bug",
    });
    expect(response.status).toBe(200);
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(RewardResult)(await response.json()),
    );
    if (!result.code || !result.reward)
      throw new Error("Expected newly issued code");
    return { code: result.code, id: result.reward.id };
  }
  return { sql, env, hooks, request, manage, redeem, issue };
}

function stripeFixture(sql: Database, canceling = true) {
  const now = Math.floor(Date.now() / 1000);
  const end = now + 10 * 86400;
  const metadata: Record<string, string> = {};
  const subscription = {
    id: "sub_fixture",
    customer: "cus_fixture",
    status: "trialing",
    cancel_at_period_end: canceling,
    cancel_at: canceling ? end : null,
    canceled_at: canceling ? now : null,
    ended_at: canceling ? null : now,
    trial_start: now - 86400,
    trial_end: end,
    billing_cycle_anchor: end,
    metadata,
    discounts: [],
    collection_method: "charge_automatically",
    items: {
      data: [
        {
          id: "si_fixture",
          quantity: 1,
          discounts: [],
          current_period_start: now - 86400,
          current_period_end: end,
          price: {
            id: "price_fixture",
            lookup_key: "dotflowy_unlimited_monthly",
            billing_scheme: "per_unit",
            recurring: { interval: "month", usage_type: "licensed" },
          },
        },
      ],
    },
  };
  sql.exec(`
    UPDATE user SET stripeCustomerId='cus_fixture' WHERE id='recipient';
    INSERT INTO subscription(id,plan,referenceId,status,stripeSubscriptionId)
      VALUES ('subscription-row','unlimited','recipient','trialing','sub_fixture');
  `);
  const writes: string[] = [];
  const transport = { unavailable: false, writes };
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(
          Schema.is(Schema.String)(input)
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const method = init?.method ?? "GET";
        if (method !== "GET")
          transport.writes.push(`${method} ${url.pathname}`);
        if (url.hostname !== "api.stripe.com" || method !== "GET")
          throw new Error(
            "Unexpected fixture request; no network access permitted",
          );
        if (transport.unavailable)
          return Response.json(
            {
              error: { type: "api_error", message: "Fixture provider outage" },
            },
            { status: 503 },
          );
        if (url.pathname === "/v1/subscriptions/sub_fixture")
          return Response.json(subscription);
        if (url.pathname === "/v1/subscriptions")
          return Response.json({
            object: "list",
            data: [subscription],
            has_more: false,
          });
        if (["/v1/invoices", "/v1/invoiceitems"].includes(url.pathname))
          return Response.json({ object: "list", data: [], has_more: false });
        throw new Error(`Unexpected fixture path ${url.pathname}`);
      },
      { preconnect() {} },
    ),
  );
  return { subscription, transport, restore: () => fetch.mockRestore() };
}

test("admin replacement completed after code lookup prevents the old claim and leaves the replacement redeemable", async () => {
  const f = await rewardsFixture();
  try {
    const original = await f.issue();
    let replacement: string | undefined;
    f.hooks.afterCodeLookup = async () => {
      const response = await f.manage({ action: "replace", id: original.id });
      expect(response.status).toBe(200);
      const result = await Effect.runPromise(
        Schema.decodeUnknownEffect(RewardResult)(await response.json()),
      );
      replacement = result.code;
      expect(replacement).toBeString();
    };
    expect((await f.redeem(original.code)).status).toBe(409);
    expect(
      f.sql
        .query("SELECT userId,claimedAt,state FROM pro_reward WHERE id=?")
        .get(original.id),
    ).toEqual({ userId: null, claimedAt: null, state: "issued" });
    if (!replacement) throw new Error("Replacement handler did not run");
    expect(replacement).not.toBe(original.code);
    const claimed = await f.redeem(replacement);
    expect(claimed.status).toBe(200);
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(RewardResult)(await claimed.json()),
    );
    expect(result.reward).toMatchObject({ id: original.id, state: "applied" });
    expect(
      f.sql
        .query("SELECT userId,gift FROM pro_reward WHERE id=?")
        .get(original.id),
    ).toEqual({ userId: "recipient", gift: 1 });
    expect((await f.redeem(original.code)).status).toBe(409);
    const retry = await f.redeem(replacement);
    expect(retry.status).toBe(200);
    expect(
      await Effect.runPromise(
        Schema.decodeUnknownEffect(RewardResult)(await retry.json()),
      ),
    ).toEqual(result);
  } finally {
    f.sql.close();
  }
});

test("storage faults are server failures, while invalid input and a competing membership lease retain client statuses", async () => {
  const f = await rewardsFixture();
  try {
    const issued = await f.issue();
    for (const body of [
      "{",
      JSON.stringify({
        code: issued.code,
        accountId: "recipient",
        consent: false,
      }),
    ])
      expect((await f.request("/api/membership/redeem", body)).status).toBe(
        400,
      );
    f.sql
      .query(
        "INSERT INTO pro_reward_lock VALUES ('recipient','another-request',?)",
      )
      .run(Date.now() + 300_000);
    expect((await f.redeem(issued.code)).status).toBe(409);
    f.sql.exec("DELETE FROM pro_reward_lock");
    // Fail at distinct durable boundaries: acquiring the lease, finding a
    // code, claiming it, delivering access, and releasing the lease.
    for (const boundary of [
      /INSERT INTO pro_reward_lock/i,
      /SELECT\s+\*\s+FROM pro_reward WHERE codeHash/i,
      /UPDATE pro_reward SET userId/i,
      /UPDATE pro_reward SET state='applied',gift=1/i,
      /DELETE FROM pro_reward_lock/i,
    ]) {
      const next = await f.issue();
      let failed = false;
      f.hooks.beforeQuery = (query) => {
        if (!failed && boundary.test(query)) {
          failed = true;
          throw new Error("Fixture D1 unavailable");
        }
      };
      const response = await f.redeem(next.code);
      expect(failed).toBe(true);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.status).toBeLessThan(600);
      f.hooks.beforeQuery = undefined;
      // A failed release represents a lease that must expire before retry.
      f.sql.exec("UPDATE pro_reward_lock SET untilAt=0");
      const retry = await f.redeem(next.code);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        reward: { id: next.id, state: "applied" },
      });
    }
  } finally {
    f.sql.close();
  }
});

test("provider outages and missing billing configuration are retryable server failures without consuming or replacing the reward", async () => {
  const f = await rewardsFixture();
  let unavailable = true;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(
          Schema.is(Schema.String)(input)
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        expect(url.hostname).toBe("api.stripe.com");
        expect(init?.method ?? "GET").toBe("GET");
        expect([
          "/v1/subscriptions",
          "/v1/invoices",
          "/v1/invoiceitems",
        ]).toContain(url.pathname);
        return unavailable
          ? Response.json(
              {
                error: {
                  type: "api_error",
                  message: "Fixture Stripe unavailable",
                },
              },
              { status: 503 },
            )
          : Response.json({ object: "list", data: [], has_more: false });
      },
      { preconnect() {} },
    ),
  );
  try {
    f.sql.exec(
      "UPDATE user SET stripeCustomerId='cus_fixture' WHERE id='recipient'",
    );
    const issued = await f.issue();
    Object.assign(f.env, { STRIPE_SECRET_KEY: "sk_test_disposable_fixture" });
    const outage = await f.redeem(issued.code);
    expect(outage.status).toBeGreaterThanOrEqual(500);
    expect(outage.status).toBeLessThan(600);
    expect(fetch).toHaveBeenCalled();
    Object.assign(f.env, { STRIPE_SECRET_KEY: undefined });
    const missingConfig = await f.redeem(issued.code);
    expect(missingConfig.status).toBe(503);
    Object.assign(f.env, { STRIPE_SECRET_KEY: "sk_test_disposable_fixture" });
    expect(
      f.sql
        .query("SELECT startsAt,endsAt FROM pro_reward WHERE id=?")
        .get(issued.id),
    ).toEqual({ startsAt: null, endsAt: null });
    unavailable = false;
    const retry = await f.redeem(issued.code);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      reward: { id: issued.id, state: "applied" },
    });
    expect(
      f.sql.query("SELECT COUNT(*) AS count FROM pro_reward").get(),
    ).toEqual({ count: 1 });
  } finally {
    fetch.mockRestore();
    f.sql.close();
  }
});

test.each([false, true])(
  "checkout completion is attempt- and identity-bound (gift=%s)",
  async (gift) => {
    const f = await rewardsFixture();
    let giftId: string | undefined;
    if (gift) {
      const issued = await f.issue();
      giftId = issued.id;
      expect((await f.redeem(issued.code)).status).toBe(200);
    }
    const stripe = stripeFixture(f.sql, false);
    const env = { ...f.env, STRIPE_SECRET_KEY: "sk_test_disposable_fixture" };
    try {
      const first = await Effect.runPromise(
        giftCheckoutParams(f.env.DB, "recipient", "unlimited", false),
      );
      const a = f.sql
        .query<{ attemptId: string }, []>(
          "SELECT attemptId FROM membership_checkout",
        )
        .get();
      if (!a) throw new Error("Expected checkout A reservation");
      expect(first.params.metadata).toMatchObject({
        dotflowyCheckout: a.attemptId,
        dotflowyCheckoutUser: "recipient",
      });
      expect(first.params.subscription_data?.metadata).toMatchObject({
        dotflowyCheckout: a.attemptId,
        dotflowyCheckoutUser: "recipient",
      });
      f.sql.exec("UPDATE membership_checkout SET expiresAt=0");
      const second = await Effect.runPromise(
        giftCheckoutParams(f.env.DB, "recipient", "unlimited", false),
      );
      const b = f.sql
        .query<{ attemptId: string; giftEnd: number | null }, []>(
          "SELECT attemptId,giftEnd FROM membership_checkout",
        )
        .get();
      if (!b) throw new Error("Expected checkout B reservation");
      expect(b.attemptId).not.toBe(a.attemptId);
      expect(second.params.metadata).toMatchObject({
        dotflowyCheckout: b.attemptId,
        dotflowyCheckoutUser: "recipient",
      });
      expect(second.params.subscription_data?.metadata).toMatchObject({
        dotflowyCheckout: b.attemptId,
        dotflowyCheckoutUser: "recipient",
      });
      if (gift) {
        expect(second.params.metadata).toMatchObject({
          dotflowyGift: "recipient",
        });
        expect(second.params.subscription_data?.metadata).toMatchObject({
          dotflowyGift: "recipient",
        });
        if (b.giftEnd === null) throw new Error("Expected gifted checkout end");
        expect(second.params.subscription_data?.trial_end).toBe(
          Math.ceil(b.giftEnd / 1000),
        );
        stripe.subscription.trial_end = Math.ceil(b.giftEnd / 1000);
      }
      Object.assign(stripe.subscription.metadata, {
        dotflowyCheckout: a.attemptId,
        dotflowyCheckoutUser: "recipient",
      });
      if (gift) stripe.subscription.metadata.dotflowyGift = "recipient";
      const reservation = () =>
        f.sql.query("SELECT * FROM membership_checkout").get();
      const preserved = reservation();
      const giftRow = () =>
        f.sql
          .query("SELECT gift,subscriptionId FROM pro_reward WHERE id=?")
          .get(giftId ?? "no-gift");
      const originalGift = giftRow();
      // A completed against its own Stripe subscription after B replaced it.
      await Effect.runPromise(
        reconcileMembershipCheckout(
          env,
          "sub_fixture",
          "recipient",
          a.attemptId,
        ),
      );
      expect(reservation()).toEqual(preserved);
      expect(giftRow()).toEqual(originalGift);
      // Even a callback labeled B cannot consume it using stale Stripe metadata.
      await Effect.runPromise(
        reconcileMembershipCheckout(
          env,
          "sub_fixture",
          "recipient",
          b.attemptId,
        ).pipe(Effect.exit),
      );
      expect(reservation()).toEqual(preserved);
      expect(giftRow()).toEqual(originalGift);
      stripe.subscription.metadata.dotflowyCheckout = b.attemptId;
      for (const mismatch of ["user", "customer", "status"]) {
        stripe.subscription.metadata.dotflowyCheckoutUser =
          mismatch === "user" ? "another-user" : "recipient";
        stripe.subscription.customer =
          mismatch === "customer" ? "cus_another" : "cus_fixture";
        stripe.subscription.status =
          mismatch === "status" ? "canceled" : "trialing";
        await Effect.runPromise(
          reconcileMembershipCheckout(
            env,
            "sub_fixture",
            "recipient",
            b.attemptId,
          ).pipe(Effect.exit),
        );
        expect(reservation()).toEqual(preserved);
        expect(giftRow()).toEqual(originalGift);
      }
      stripe.subscription.status = gift ? "trialing" : "active";
      if (gift) {
        stripe.subscription.metadata.dotflowyGift = "another-user";
        await Effect.runPromise(
          reconcileMembershipCheckout(
            env,
            "sub_fixture",
            "recipient",
            b.attemptId,
          ).pipe(Effect.exit),
        );
        expect(reservation()).toEqual(preserved);
        expect(giftRow()).toEqual(originalGift);
        stripe.subscription.metadata.dotflowyGift = "recipient";
        if (b.giftEnd === null) throw new Error("Expected gifted checkout end");
        for (const early of ["fixed", "period"]) {
          stripe.subscription.cancel_at =
            early === "fixed" ? b.giftEnd / 1000 - 1 : null;
          stripe.subscription.cancel_at_period_end = early === "period";
          await Effect.runPromise(
            reconcileMembershipCheckout(
              env,
              "sub_fixture",
              "recipient",
              b.attemptId,
            ).pipe(Effect.exit),
          );
          expect(reservation()).toEqual(preserved);
          expect(giftRow()).toEqual(originalGift);
          expect(stripe.subscription.cancel_at_period_end).toBe(
            early === "period",
          );
        }
        // Cancellation exactly at the gift deadline loses no earned time.
        stripe.subscription.cancel_at_period_end = false;
        stripe.subscription.cancel_at = b.giftEnd / 1000;
      }
      await Effect.runPromise(
        reconcileMembershipCheckout(
          env,
          "sub_fixture",
          "recipient",
          b.attemptId,
        ),
      );
      expect(reservation()).toBeNull();
      if (gift) {
        expect(giftRow()).toEqual({ gift: 0, subscriptionId: "sub_fixture" });
        expect(f.sql.query("SELECT status FROM subscription").get()).toEqual({
          status: "trialing",
        });
      }
      expect(stripe.subscription.status).toBe(gift ? "trialing" : "active");
      await Effect.runPromise(
        reconcileMembershipCheckout(
          env,
          "sub_fixture",
          "recipient",
          b.attemptId,
        ),
      );
      expect(reservation()).toBeNull();
      expect(stripe.transport.writes).toEqual([]);
    } finally {
      stripe.restore();
      f.sql.close();
    }
  },
);

test("scheduled cancellation reward survives provider outage and near-boundary retries until canceled lifecycle delivery", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = await rewardsFixture();
  const stripe = stripeFixture(f.sql);
  Object.assign(f.env, { STRIPE_SECRET_KEY: "sk_test_disposable_fixture" });
  const end = stripe.subscription.trial_end;
  try {
    const issued = await f.issue();
    const scheduled = await f.redeem(issued.code);
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({
      reward: { id: issued.id, state: "scheduled" },
    });
    const row = () =>
      f.sql
        .query(
          "SELECT state,originalEnd,startsAt,endsAt FROM pro_reward WHERE id=?",
        )
        .get(issued.id);
    const expected = {
      state: "scheduled",
      originalEnd: end * 1000,
      startsAt: null,
      endsAt: null,
    };
    expect(row()).toEqual(expected);
    stripe.transport.unavailable = true;
    expect((await f.redeem(issued.code)).status).toBe(503);
    expect(row()).toEqual(expected);
    stripe.transport.unavailable = false;
    now = (end - 3600) * 1000;
    const nearEnd = await f.redeem(issued.code);
    expect(nearEnd.status).toBe(200);
    expect(await nearEnd.json()).toMatchObject({
      reward: { id: issued.id, state: "scheduled" },
    });
    expect(row()).toEqual(expected);
    now = (end + 60) * 1000;
    stripe.subscription.status = "canceled";
    stripe.subscription.ended_at = end;
    // Do not deliver a new overlapping gift while cancellation A is unresolved.
    const later = await f.issue();
    const held = await f.redeem(later.code);
    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({ reward: { state: "review" } });
    expect(
      f.sql.query("SELECT gift FROM pro_reward WHERE id=?").get(later.id),
    ).toEqual({ gift: 0 });
    await Effect.runPromise(reconcileRewards(f.env, "sub_fixture"));
    const delivered = {
      state: "applied",
      originalEnd: end * 1000,
      startsAt: end * 1000,
      endsAt: (end + 30 * 86400) * 1000,
    };
    expect(row()).toEqual(delivered);
    await Effect.runPromise(reconcileRewards(f.env, "sub_fixture"));
    expect(row()).toEqual(delivered);
    const released = await f.redeem(later.code);
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({
      reward: {
        state: "applied",
        startsAt: (end + 30 * 86400) * 1000,
        endsAt: (end + 60 * 86400) * 1000,
      },
    });
    expect(
      f.sql.query("SELECT status,cancelAtPeriodEnd FROM subscription").get(),
    ).toEqual({ status: "canceled", cancelAtPeriodEnd: 1 });
    expect(stripe.subscription.status).toBe("canceled");
    expect(stripe.transport.writes).toEqual([]);
  } finally {
    stripe.restore();
    clock.mockRestore();
    f.sql.close();
  }
});

test("late cancellation reconciliation stacks two scheduled gifts through expired coverage and replays without shortening them", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const f = await rewardsFixture();
  const stripe = stripeFixture(f.sql);
  const env = { ...f.env, STRIPE_SECRET_KEY: "sk_test_disposable_fixture" };
  const day = 86400_000;
  const end = now - 40 * day;
  stripe.subscription.status = "canceled";
  stripe.subscription.trial_end = end / 1000;
  stripe.subscription.ended_at = end / 1000;
  stripe.subscription.cancel_at = end / 1000;
  stripe.subscription.items.data[0]!.current_period_end = end / 1000;
  try {
    for (const [id, createdAt] of [
      ["scheduled-first", 1],
      ["scheduled-second", 2],
    ] as const)
      f.sql
        .query(`INSERT INTO pro_reward
        (id,userId,bug,issuer,createdAt,claimBy,claimedAt,state,subscriptionId,originalEnd)
        VALUES (?,'recipient',?,'admin',?,?,?,'scheduled','sub_fixture',?)`)
        .run(id, id, createdAt, now + day, end - day, end);
    const windows = () =>
      f.sql
        .query(
          "SELECT id,state,gift,startsAt,endsAt FROM pro_reward ORDER BY createdAt,id",
        )
        .all();
    await Effect.runPromise(reconcileRewards(env, "sub_fixture"));
    const expected = [
      {
        id: "scheduled-first",
        state: "applied",
        gift: 1,
        startsAt: end,
        endsAt: end + 30 * day,
      },
      {
        id: "scheduled-second",
        state: "applied",
        gift: 1,
        startsAt: end + 30 * day,
        endsAt: end + 60 * day,
      },
    ];
    expect(windows()).toEqual(expected);
    expect(await Effect.runPromise(giftWindow(f.env.DB, "recipient"))).toEqual({
      startsAt: end + 30 * day,
      endsAt: now + 20 * day,
    });
    await Effect.runPromise(reconcileRewards(env, "sub_fixture"));
    expect(windows()).toEqual(expected);
    expect(
      f.sql
        .query("SELECT status,cancelAtPeriodEnd,endedAt FROM subscription")
        .get(),
    ).toEqual({ status: "canceled", cancelAtPeriodEnd: 1, endedAt: end });
    expect(stripe.subscription.status).toBe("canceled");
    expect(stripe.transport.writes).toEqual([]);
  } finally {
    stripe.restore();
    clock.mockRestore();
    f.sql.close();
  }
});
