import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";

import type { FeedbackSubmission } from "../src/data/feedback";
import type { FeedbackEnv, FeedbackSession } from "./feedback";

import { FeedbackReceipt } from "../src/data/feedback";
import { FeedbackInbox, FeedbackTriage } from "../src/data/feedback-admin";
import { handleFeedbackInboxRequest, handleFeedbackRequest } from "./feedback";

let mf: Miniflare;
let env: FeedbackEnv;

beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: "feedback-test",
          compatibilityDate: "2026-09-01",
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: new TextEncoder().encode(
                  "export default { fetch() { return new Response('test'); } }",
                ),
              },
            },
          },
          env: { DB: { type: "d1", id: "feedback-db" } },
        },
      },
    ],
  });
  const DB: D1Database = await mf.getD1Database("DB");
  env = {
    DB,
    ADMIN_USER_IDS: "owner",
    FEEDBACK_NOTIFICATION_EMAIL: "cam@example.test",
    EMAIL: {
      async send() {
        return { messageId: crypto.randomUUID() };
      },
    },
  };
  for (const file of [
    "0003_create_auth.sql",
    "0006_create_stripe.sql",
    "0018_first_party_feedback.sql",
    "0019_feedback_triage.sql",
    "0020_feedback_replies.sql",
  ]) {
    const sql = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      "utf8",
    );
    await DB.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
  }
});

afterAll(async () => {
  await mf?.dispose();
});

async function account(plan?: string, status = "active") {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Fixture', ?, 1, 0, 0)`,
  )
    .bind(id, `${id}@example.test`)
    .run();
  if (plan)
    await env.DB.prepare(
      "INSERT INTO subscription (id, plan, referenceId, status) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), plan, id, status)
      .run();
  return { user: { id, email: `${id}@example.test` } };
}

function draft(
  overrides: Partial<FeedbackSubmission> = {},
): FeedbackSubmission {
  return {
    id: crypto.randomUUID(),
    kind: "bug",
    message: "The menu closes before I can select an item.",
    context: { appVersion: "3.2.0" },
    ...overrides,
  };
}

function submit<T>(
  session: FeedbackSession,
  body: T,
  options: {
    method?: string;
    raw?: string;
    contentType?: string;
    env?: FeedbackEnv;
    background?: Promise<unknown>[];
  } = {},
) {
  return Effect.runPromise(
    handleFeedbackRequest(
      new Request("https://fixture/api/feedback?private=node", {
        method: options.method ?? "POST",
        headers: {
          "content-type": options.contentType ?? "application/json",
          referer: "https://fixture/secret-node?outline=private",
        },
        body: options.raw ?? JSON.stringify(body),
      }),
      options.env ?? env,
      session,
      { waitUntil: (promise) => options.background?.push(promise) },
    ),
  );
}

function inbox(session: FeedbackSession, query = "", method = "GET") {
  return Effect.runPromise(
    handleFeedbackInboxRequest(
      new Request(`https://fixture/api/admin/feedback${query}`, { method }),
      env,
      session,
      { waitUntil() {} },
    ),
  );
}

function triage<T>(
  session: FeedbackSession,
  body: T,
  origin = "https://fixture",
  contentType = "application/json",
) {
  return Effect.runPromise(
    handleFeedbackInboxRequest(
      new Request("https://fixture/api/admin/feedback", {
        method: "POST",
        headers: { origin, "content-type": contentType },
        body: JSON.stringify(body),
      }),
      env,
      session,
      { waitUntil() {} },
    ),
  );
}

test("admin replies use the account's verified email, stay separate from private notes, and require explicit sending", async () => {
  const owner = { user: { id: "owner", email: "owner@example.test" } };
  const reporter = await account();
  const report = draft({ message: "PRIVATE_ORIGINAL_REPORT" });
  await submit(reporter, report);
  const read = async () =>
    Schema.decodeUnknownSync(FeedbackInbox)(await (await inbox(owner)).json());
  const entry = (await read()).submissions.find(
    (item) => item.requestId === report.id,
  )!;
  expect(entry).toMatchObject({
    email: reporter.user.email,
    emailVerified: true,
    replies: [],
  });
  await triage(owner, {
    id: entry.id,
    action: "comment",
    commentId: crypto.randomUUID(),
    message: "PRIVATE_INTERNAL_COMMENT",
  });
  const reply = {
    id: entry.id,
    action: "reply",
    replyId: crypto.randomUUID(),
    recipientEmail: entry.email,
    message: "Hi,\n\nFixed <the issue> & tested it.\nThank you.",
  };
  const sent: unknown[] = [];
  const mail = spyOn(env.EMAIL!, "send").mockImplementation(async (message) => {
    sent.push(message);
    return { messageId: "provider-reply" };
  });
  try {
    for (const session of [null, reporter, await account("founding")])
      expect((await triage(session, reply)).status).toBe(404);
    expect((await triage(owner, reply)).status).toBe(503); // Live sending defaults off.
    env.FEEDBACK_REPLY_MODE = "send";
    expect((await triage(owner, reply, "https://evil.test")).status).toBe(403);
    for (const extra of [
      { to: "someone@example.test" },
      { sender: "personal@example.test" },
      { subject: "arbitrary" },
    ])
      expect((await triage(owner, { ...reply, ...extra })).status).toBe(400);
    expect(
      (
        await triage(owner, {
          ...reply,
          recipientEmail: "someone@example.test",
        })
      ).status,
    ).toBe(409);
    await env.DB.prepare('UPDATE "user" SET emailVerified = 0 WHERE id = ?')
      .bind(reporter.user.id)
      .run();
    expect((await triage(owner, reply)).status).toBe(409);
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?')
      .bind(reporter.user.id)
      .run();
    env.FEEDBACK_REPLY_MODE = "simulate";
    const simulated = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, reply)).json(),
    );
    expect(simulated.replies).toEqual([
      {
        id: reply.replyId,
        message: reply.message,
        recipientEmail: reporter.user.email,
        status: "simulated",
        createdAt: expect.any(Number),
      },
    ]);
    expect(mail).not.toHaveBeenCalled();
    env.FEEDBACK_REPLY_MODE = "send";
    const send = { ...reply, replyId: crypto.randomUUID() };
    const accepted = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, send)).json(),
    );
    expect(
      accepted.replies.find((item) => item.id === send.replyId)?.status,
    ).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "Dotflowy Support <support@dotflowy.com>",
      replyTo: "support@dotflowy.com",
      to: reporter.user.email,
      subject: "An update on your Dotflowy feedback",
      text: `Hi,\n\nFixed <the issue> & tested it.\nThank you.\n\nCam\nDotflowy\n\nFeedback reference: ${report.id}`,
    });
    expect(JSON.stringify(sent)).toContain(
      "&lt;the issue&gt; &amp; tested it.",
    );
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_|owner@example/);
    expect((await triage(owner, send)).status).toBe(200);
    expect((await triage(owner, { ...send, message: "Changed" })).status).toBe(
      409,
    );
    expect(sent).toHaveLength(1);
    await env.DB.prepare('UPDATE "user" SET email = ? WHERE id = ?')
      .bind("new-address@example.test", reporter.user.id)
      .run();
    expect(
      (await triage(owner, { ...reply, replyId: crypto.randomUUID() })).status,
    ).toBe(409);
    expect(
      (await read()).submissions.find((item) => item.id === entry.id)?.email,
    ).toBe("new-address@example.test");
    const publicReceipt = await (await submit(reporter, report)).text();
    expect(publicReceipt).not.toMatch(
      /recipientEmail|replies|PRIVATE_INTERNAL_COMMENT/,
    );
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
      .bind(reporter.user.id)
      .run();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM feedback_replies WHERE submission_id = ?",
      )
        .bind(entry.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  } finally {
    mail.mockRestore();
    delete env.FEEDBACK_REPLY_MODE;
  }
});

test("concurrent and uncertain reply attempts never send twice, including failure to record provider acceptance", async () => {
  const owner = { user: { id: "owner", email: "owner@example.test" } };
  const reporter = await account();
  const report = draft();
  await submit(reporter, report);
  const entry = Schema.decodeUnknownSync(FeedbackInbox)(
    await (await inbox(owner)).json(),
  ).submissions.find((item) => item.requestId === report.id)!;
  const reply = {
    id: entry.id,
    action: "reply",
    replyId: crypto.randomUUID(),
    recipientEmail: entry.email,
    message: "The fix is available now.",
  };
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mail = spyOn(env.EMAIL!, "send").mockImplementation(async () => {
    await gate;
    return { messageId: "accepted-once" };
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  env.FEEDBACK_REPLY_MODE = "send";
  try {
    const pending = Array.from({ length: 4 }, () => triage(owner, reply));
    // Releasing the provider does not affect the atomic unique send claim.
    release();
    const replies = await Promise.all(pending);
    for (const response of replies) expect(response.status).toBe(200);
    expect(mail).toHaveBeenCalledTimes(1);
    expect((await triage(owner, reply)).status).toBe(200);
    expect(mail).toHaveBeenCalledTimes(1);
    mail.mockImplementation(async () => {
      throw new Error("PRIVATE_PROVIDER_ERROR");
    });
    const unknown = { ...reply, replyId: crypto.randomUUID() };
    const uncertain = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, unknown)).json(),
    );
    expect(
      uncertain.replies.find((item) => item.id === unknown.replyId)?.status,
    ).toBe("unknown");
    expect((await triage(owner, unknown)).status).toBe(200);
    expect(mail).toHaveBeenCalledTimes(2);
    mail.mockImplementation(async () => ({
      messageId: "accepted-before-db-failure",
    }));
    await env.DB.exec(
      "CREATE TRIGGER fail_reply_status BEFORE UPDATE ON feedback_replies BEGIN SELECT RAISE(ABORT, 'fixture status write failure'); END",
    );
    const interrupted = { ...reply, replyId: crypto.randomUUID() };
    const response = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, interrupted)).json(),
    );
    expect(
      response.replies.find((item) => item.id === interrupted.replyId)?.status,
    ).toBe("sending");
    await env.DB.exec("DROP TRIGGER fail_reply_status");
    await env.DB.prepare(
      "UPDATE feedback_replies SET created_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 120001, interrupted.replyId)
      .run();
    const checked = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, interrupted)).json(),
    );
    expect(
      checked.replies.find((item) => item.id === interrupted.replyId)?.status,
    ).toBe("unknown");
    expect(mail).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "PRIVATE_PROVIDER_ERROR",
    );
  } finally {
    await env.DB.exec("DROP TRIGGER IF EXISTS fail_reply_status");
    mail.mockRestore();
    log.mockRestore();
    delete env.FEEDBACK_REPLY_MODE;
  }
});

test("admins complete, reopen and privately comment without duplicate notes or customer notifications", async () => {
  const owner = { user: { id: "owner", email: "owner@example.test" } };
  const reporter = await account();
  const background: Promise<unknown>[] = [];
  const first = draft();
  const second = draft({ message: "A separate report" });
  await submit(reporter, first, { background });
  await submit(reporter, second, { background });
  await Promise.all(background);
  const read = async (query = "") =>
    Schema.decodeUnknownSync(FeedbackInbox)(
      await (await inbox(owner, query)).json(),
    );
  const reports = (await read()).submissions;
  const original = reports.find((report) => report.requestId === first.id)!;
  const other = reports.find((report) => report.requestId === second.id)!;
  expect(original).toMatchObject({ completedAt: null, comments: [] });
  const note = {
    id: original.id,
    action: "comment",
    commentId: crypto.randomUUID(),
    message: "PRIVATE_ADMIN_NOTE: reproduced; investigate focus handling.",
  };
  for (const session of [null, reporter, await account("founding")]) {
    expect((await inbox(session)).status).toBe(404);
    for (const body of [
      note,
      { id: original.id, action: "complete" },
      { ...note, action: "reopen" },
      {},
    ]) {
      const response = await triage(session, body);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('{"error":"not_found"}');
    }
  }
  expect((await triage(owner, note, "https://evil.test")).status).toBe(403);
  expect((await triage(owner, note, "null")).status).toBe(403);
  expect(
    (await triage(owner, note, "https://fixture", "text/plain")).status,
  ).toBe(415);
  for (const body of [
    { ...note, action: "delete" },
    { ...note, id: 0 },
    { ...note, id: 1.5 },
    { ...note, message: " " },
    { ...note, message: "x".repeat(5001) },
    { ...note, authorId: "someone-else" },
  ])
    expect((await triage(owner, body)).status).toBe(400);
  expect((await inbox(owner, "?status=invalid")).status).toBe(400);
  expect((await triage(owner, { id: 999999, action: "complete" })).status).toBe(
    404,
  );
  expect((await triage(owner, { ...note, id: 999999 })).status).toBe(404);
  const mail = spyOn(env.EMAIL!, "send");
  try {
    for (const response of await Promise.all(
      Array.from({ length: 4 }, () => triage(owner, note)),
    )) {
      expect(response.status).toBe(200);
      const saved = Schema.decodeUnknownSync(FeedbackTriage)(
        await response.json(),
      );
      expect(saved.comments).toEqual([
        {
          id: note.commentId,
          message: note.message,
          createdAt: expect.any(Number),
        },
      ]);
    }
    expect(
      (await triage(owner, { ...note, message: "Changed note" })).status,
    ).toBe(409);
    expect((await triage(owner, { ...note, id: other.id })).status).toBe(409);
    const completed = await triage(owner, {
      id: original.id,
      action: "complete",
    });
    const saved = Schema.decodeUnknownSync(FeedbackTriage)(
      await completed.json(),
    );
    expect(saved.completedAt).toEqual(expect.any(Number));
    expect(
      Schema.decodeUnknownSync(FeedbackTriage)(
        await (
          await triage(owner, { id: original.id, action: "complete" })
        ).json(),
      ),
    ).toEqual(saved);
    const closedList = (await read("?status=complete&kind=bug&plan=free"))
      .submissions;
    expect(
      closedList.find((report) => report.id === original.id),
    ).toMatchObject(saved);
    expect(closedList.some((report) => report.id === other.id)).toBe(false);
    expect(
      (await read("?status=open")).submissions.some(
        (report) => report.id === original.id,
      ),
    ).toBe(false);
    expect(
      (await read("?status=open")).submissions.some(
        (report) => report.id === other.id,
      ),
    ).toBe(true);
    const reopen = Schema.decodeUnknownSync(FeedbackTriage)(
      await (await triage(owner, { id: original.id, action: "reopen" })).json(),
    );
    expect(reopen).toEqual({ ...saved, completedAt: null });
    // A fresh read proves durable state, not just an optimistic response.
    expect(
      (await read("?status=open")).submissions.find(
        (report) => report.id === original.id,
      ),
    ).toMatchObject(reopen);
    const followup = {
      ...note,
      commentId: crypto.randomUUID(),
      message: "x".repeat(5000),
    };
    expect((await triage(owner, followup)).status).toBe(200);
    const retry = await submit(reporter, first);
    const receipt = await retry.text();
    expect(
      Schema.decodeUnknownSync(FeedbackReceipt)(JSON.parse(receipt)),
    ).toEqual({ id: first.id, replayed: true });
    expect(receipt).not.toContain("PRIVATE_ADMIN_NOTE");
    expect(receipt).not.toContain("completedAt");
    expect(mail).not.toHaveBeenCalled();
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
      .bind(reporter.user.id)
      .run();
    expect(
      (await read()).submissions.some((report) => report.id === original.id),
    ).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM feedback_comments WHERE submission_id IN (?, ?)",
      )
        .bind(original.id, other.id)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  } finally {
    mail.mockRestore();
  }
});

test("accepted feedback emails its account and owner once, privately, without delaying storage", async () => {
  for (const [plan, kind, label] of [
    [undefined, "bug", "Free"],
    ["unlimited", "idea", "Pro"],
    ["founding", "question", "Founding"],
  ] as const) {
    const member = await account(plan);
    const body = draft({
      kind,
      message: "PRIVATE_REPORT_TEXT",
      context: {
        appVersion: "3.2.0",
        browser: "PRIVATE_BROWSER",
        routeCategory: "outline",
      },
    });
    const sent: Array<{
      to?: unknown;
      subject?: string;
      text?: string;
      html?: string;
    }> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background: Promise<unknown>[] = [];
    const options = {
      background,
      env: {
        ...env,
        EMAIL: {
          async send(message) {
            sent.push(message);
            await gate;
            return { messageId: crypto.randomUUID() };
          },
        },
      } satisfies FeedbackEnv,
    };
    // The mail provider remains pending throughout concurrent HTTP acceptance/replays.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => submit(member, body, options)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(
      await env.DB.prepare(
        "SELECT message FROM feedback_submissions WHERE user_id = ? AND request_id = ?",
      )
        .bind(member.user.id, body.id)
        .first<{ message: string }>(),
    ).toEqual({ message: "PRIVATE_REPORT_TEXT" });
    release();
    await Promise.all(background);
    expect(sent).toHaveLength(2);
    const receipt = sent.find((m) => m.to === member.user.email)!;
    const alert = sent.find((m) => m.to === "cam@example.test")!;
    expect(receipt.subject).toBe("We received your Dotflowy feedback");
    expect(receipt.text).toContain(body.id);
    expect(receipt.text?.includes("Thank you for supporting Dotflowy")).toBe(
      plan !== undefined,
    );
    expect(alert.subject).toBe(`Dotflowy feedback: ${kind} (${label})`);
    expect(alert.text).toContain(member.user.email);
    expect(alert.html).toContain(
      'href="https://app.dotflowy.com/admin/feedback"',
    );
    for (const mail of sent) {
      expect(mail.html).toBeTruthy();
      expect(mail.text).toBeTruthy();
      expect(JSON.stringify(mail)).not.toMatch(
        /PRIVATE_|private=node|secret-node/,
      );
    }
    expect(
      (await submit(member, { ...body, message: "Changed" }, options)).status,
    ).toBe(409);
    expect(
      (await submit(member, { ...body, id: "invalid" }, options)).status,
    ).toBe(400);
    expect(sent).toHaveLength(2);
  }
});

test("a failed receipt does not lose feedback or prevent the owner alert; retry never re-emails", async () => {
  const member = await account();
  const body = draft();
  const delivered: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const log = spyOn(console, "error").mockImplementation(() => {});
  const options = {
    background,
    env: {
      ...env,
      EMAIL: {
        async send(message) {
          if (message.to === member.user.email)
            throw new Error("provider unavailable");
          delivered.push(message.to);
          return { messageId: "owner-alert" };
        },
      },
    } satisfies FeedbackEnv,
  };
  try {
    expect((await submit(member, body, options)).status).toBe(201);
    await Promise.all(background);
    expect(delivered).toEqual(["cam@example.test"]);
    expect((await submit(member, body, options)).status).toBe(200);
    expect(delivered).toEqual(["cam@example.test"]);
    expect(
      await env.DB.prepare(
        "SELECT message FROM feedback_submissions WHERE user_id = ? AND request_id = ?",
      )
        .bind(member.user.id, body.id)
        .first<{ message: string }>(),
    ).toEqual({ message: body.message });
    expect(JSON.stringify(log.mock.calls)).not.toContain(body.message);
  } finally {
    log.mockRestore();
  }
});

test("session identity and current D1 membership authorize feedback; only admins can read it", async () => {
  const free = await account();
  expect((await submit(null, draft())).status).toBe(401);
  expect((await submit(free, draft())).status).toBe(201);
  for (const kind of ["idea", "question"] as const)
    expect((await submit(free, draft({ kind }))).status).toBe(403);
  // Active/trialing comps have no Stripe ids and still get member feedback.
  for (const [plan, status] of [
    ["unlimited", "active"],
    ["founding", "trialing"],
  ]) {
    const member = await account(plan, status);
    for (const kind of ["bug", "idea", "question"] as const)
      expect((await submit(member, draft({ kind }))).status).toBe(201);
  }
  for (const [plan, status] of [
    ["founding", "canceled"],
    ["unlimited", "past_due"],
    ["unknown", "active"],
  ]) {
    const member = await account(plan, status);
    expect((await submit(member, draft({ kind: "idea" }))).status).toBe(403);
    expect((await submit(member, draft())).status).toBe(201);
  }
  expect(
    (await submit(free, { ...draft(), plan: "founding", userId: "owner" }))
      .status,
  ).toBe(400);
  const owner = { user: { id: "owner", email: "owner@example.test" } };
  expect((await inbox(null)).status).toBe(404);
  expect((await inbox(free, "?limit=invalid", "POST")).status).toBe(404);
  expect((await inbox(owner, "", "PATCH")).status).toBe(405);
  expect((await inbox(owner, "?limit=101")).status).toBe(400);
  expect((await inbox(owner, "?kind=unknown")).status).toBe(400);
  expect((await inbox(owner, "?plan=unknown")).status).toBe(400);
  const latest = draft({ message: "Newest free bug in the inbox" });
  expect((await submit(free, latest)).status).toBe(201);
  const result = await inbox(owner, "?kind=bug&plan=free&limit=1");
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  const body = await result.json();
  expect(body).toMatchObject({
    submissions: [
      {
        requestId: latest.id,
        userId: free.user.id,
        message: "Newest free bug in the inbox",
        plan: "free",
        kind: "bug",
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("payload_hash");
});

test("concurrent retries are one account-scoped submission, conflict on changed body, and survive downgrade", async () => {
  const member = await account("founding");
  const body = draft({
    kind: "idea",
    context: { appVersion: "3.2.0", routeCategory: "outline" },
  });
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => submit(member, body)),
  );
  expect(replies.map((r) => r.status).sort()).toEqual([
    200, 200, 200, 200, 201,
  ]);
  for (const changed of [
    { ...body, message: "Different feedback" },
    { ...body, kind: "question" },
    { ...body, context: { ...body.context, browser: "Browser" } },
  ])
    expect((await submit(member, changed)).status).toBe(409);
  // Wire ordering/whitespace is immaterial to the canonical content digest.
  const reordered = JSON.stringify(
    {
      context: { routeCategory: "outline", appVersion: "3.2.0" },
      message: body.message,
      kind: body.kind,
      id: body.id,
    },
    null,
    2,
  );
  expect((await submit(member, null, { raw: reordered })).status).toBe(200);
  await env.DB.prepare(
    "UPDATE subscription SET status = 'canceled' WHERE referenceId = ?",
  )
    .bind(member.user.id)
    .run();
  const retry = await submit(member, body);
  expect(await retry.json()).toMatchObject({ id: body.id, replayed: true });
  expect((await submit(member, draft({ kind: "idea" }))).status).toBe(403);
  const other = await account();
  expect(
    (await submit(other, { ...body, kind: "bug", message: "Another account" }))
      .status,
  ).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT user_id, plan, message FROM feedback_submissions WHERE user_id = ?",
    )
      .bind(member.user.id)
      .all(),
  ).toMatchObject({
    results: [
      { user_id: member.user.id, plan: "founding", message: body.message },
    ],
  });
  await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
    .bind(member.user.id)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feedback_submissions WHERE user_id = ?",
    )
      .bind(member.user.id)
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
});

test("the persistent rolling quota is atomic under concurrency, excludes retries, and expires", async () => {
  const user = await account();
  const bodies = Array.from({ length: 14 }, () => draft());
  const replies = await Promise.all(bodies.map((body) => submit(user, body)));
  expect(replies.filter((r) => r.status === 201)).toHaveLength(10);
  expect(replies.filter((r) => r.status === 429)).toHaveLength(4);
  const accepted = bodies[replies.findIndex((r) => r.status === 201)];
  if (!accepted) throw new Error("Expected an accepted submission");
  expect((await submit(user, accepted)).status).toBe(200);
  expect((await submit(user, draft())).status).toBe(429);
  const another = await account();
  expect((await submit(another, draft())).status).toBe(201);
  await env.DB.prepare(
    "UPDATE feedback_submissions SET created_at = ? WHERE user_id = ? AND request_id = ?",
  )
    .bind(Date.now() - 86400001, user.user.id, accepted.id)
    .run();
  expect((await submit(user, draft())).status).toBe(201);
  expect((await submit(user, draft())).status).toBe(429);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM feedback_submissions WHERE user_id = ?",
    )
      .bind(user.user.id)
      .first<{ n: number }>(),
  ).toEqual({ n: 11 });
});

test("body limits and the diagnostic allowlist reject unsafe context without reflecting private input", async () => {
  const user = await account();
  const body = draft();
  const privateText = "SECRET_OUTLINE_TEXT";
  for (const invalid of [
    { ...body, message: " " },
    { ...body, message: "x".repeat(5001) },
    { ...body, id: "too-short" },
    { ...body, id: "x".repeat(65) },
    { ...body, context: { appVersion: "x".repeat(65) } },
    { ...body, context: { appVersion: "3.2.0", browser: "x".repeat(513) } },
    ...["url", "path", "query", "outline", "screenshot"].map((key) => ({
      ...body,
      context: { ...body.context, [key]: privateText },
    })),
    {
      ...body,
      context: { ...body.context, routeCategory: `/node/${privateText}` },
    },
  ]) {
    const response = await submit(user, invalid);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(privateText);
  }
  expect((await submit(user, null, { raw: "{" })).status).toBe(400);
  expect((await submit(user, body, { contentType: "text/plain" })).status).toBe(
    415,
  );
  // No Content-Length; enforce the actual chunked bytes, not a claimed length.
  const request = new Request("https://fixture/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(" ".repeat(16000)));
        controller.enqueue(new TextEncoder().encode(" ".repeat(17000)));
        controller.close();
      },
    }),
  });
  expect(
    (
      await Effect.runPromise(
        handleFeedbackRequest(request, env, user, { waitUntil() {} }),
      )
    ).status,
  ).toBe(413);
  const safe = draft({
    message: "x".repeat(5000),
    context: {
      appVersion: "3.2.0",
      browser: "Fixture browser",
      routeCategory: "settings",
    },
  });
  expect((await submit(user, safe)).status).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT user_id, message, app_version, browser, route_category FROM feedback_submissions WHERE user_id = ?",
    )
      .bind(user.user.id)
      .all(),
  ).toMatchObject({
    results: [
      {
        user_id: user.user.id,
        message: "x".repeat(5000),
        app_version: "3.2.0",
        browser: "Fixture browser",
        route_category: "settings",
      },
    ],
  });
  const absent = draft();
  expect((await submit(user, absent)).status).toBe(201);
  expect(
    await env.DB.prepare(
      "SELECT browser, route_category FROM feedback_submissions WHERE user_id = ? AND request_id = ?",
    )
      .bind(user.user.id, absent.id)
      .first<{ browser: string | null; route_category: string | null }>(),
  ).toEqual({ browser: null, route_category: null });
});
