import { describe, expect, test } from "bun:test";

import {
  announceEmail,
  pendingAnnounceEmails,
  sendAnnouncements,
  type AnnounceEnv,
} from "./announce";

describe("announceEmail", () => {
  test("carries the signup url and the launch facts in both bodies", () => {
    const msg = announceEmail("https://dotflowy.com");
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain("https://dotflowy.com");
      expect(body).toContain("10,000");
      expect(body).toContain("$5/mo");
      expect(body).toContain("$48/yr");
      expect(body).toContain("$99");
    }
    expect(msg.subject.length).toBeGreaterThan(0);
  });

  test("is honest about the founding plan — a fixed term that auto-renews, NOT lifetime", () => {
    // Ticket #294 is explicit: the founding plan auto-renews after year three
    // unless cancelled, so the copy discloses the renewal AND explicitly denies
    // the "lifetime" framing rather than leaving it ambiguous.
    const msg = announceEmail("https://dotflowy.com");
    for (const body of [msg.text, msg.html]) {
      expect(body.toLowerCase()).toContain("auto-renew");
      expect(body.toLowerCase()).toContain("unless you cancel");
      expect(body.toLowerCase()).toContain("not a lifetime deal");
    }
  });

  test("acknowledges the recipient joined the waitlist", () => {
    const msg = announceEmail("https://dotflowy.com");
    expect(msg.text.toLowerCase()).toContain("waitlist");
    expect(msg.html.toLowerCase()).toContain("waitlist");
  });
});

/**
 * A stateful in-memory `waitlist` table, just enough to exercise the two SQL
 * statements the announcement flow issues: the conditional `notifiedAt` claim
 * and the pending-rows SELECT. The claim mirrors real D1 semantics — an UPDATE
 * that matches 0 rows reports `meta.changes === 0` — which is the whole
 * idempotency guarantee under test.
 */
function fakeWaitlistDb(
  rows: Array<{ email: string; createdAt: number; notifiedAt: number | null }>,
) {
  const db = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          return {
            run() {
              // UPDATE waitlist SET notifiedAt = ? WHERE email = ? AND notifiedAt IS NULL
              const [, email] = args as [number, string];
              const row = rows.find((r) => r.email === email);
              if (row && row.notifiedAt == null) {
                row.notifiedAt = args[0] as number;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              return Promise.resolve({ meta: { changes: 0 } });
            },
            all() {
              // SELECT email FROM waitlist WHERE notifiedAt IS NULL ... [LIMIT ?]
              const limit = args.length > 0 ? (args[0] as number) : undefined;
              const pending = rows
                .filter((r) => r.notifiedAt == null)
                .sort((a, b) => a.createdAt - b.createdAt)
                .map((r) => ({ email: r.email }));
              return Promise.resolve({
                results: limit != null ? pending.slice(0, limit) : pending,
              });
            },
          };
        },
        all() {
          // The no-bind SELECT (limit === null).
          const pending = rows
            .filter((r) => r.notifiedAt == null)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({ email: r.email }));
          return Promise.resolve({ results: pending });
        },
      };
    },
  } as unknown as D1Database;
  // EMAIL omitted: sendEmail falls back to console logging (never throws), so a
  // `notified` entry means the row was claimed and the send was attempted.
  const env: AnnounceEnv = { DB: db };
  return { env, rows };
}

describe("sendAnnouncements idempotent stamping", () => {
  test("stamps notifiedAt and sends once per un-notified row", async () => {
    const { env, rows } = fakeWaitlistDb([
      { email: "a@b.com", createdAt: 1, notifiedAt: null },
      { email: "c@d.com", createdAt: 2, notifiedAt: null },
    ]);
    const res = await sendAnnouncements(
      env,
      ["a@b.com", "c@d.com"],
      "https://dotflowy.com",
    );
    expect(res.notified.sort()).toEqual(["a@b.com", "c@d.com"]);
    expect(res.skipped).toEqual([]);
    // Every row is now stamped.
    expect(rows.every((r) => r.notifiedAt != null)).toBe(true);
  });

  test("a re-run sends to nobody — the stamp makes it safe to re-run", async () => {
    const { env } = fakeWaitlistDb([
      { email: "a@b.com", createdAt: 1, notifiedAt: null },
      { email: "c@d.com", createdAt: 2, notifiedAt: null },
    ]);
    await sendAnnouncements(
      env,
      ["a@b.com", "c@d.com"],
      "https://dotflowy.com",
    );
    const second = await sendAnnouncements(
      env,
      ["a@b.com", "c@d.com"],
      "https://dotflowy.com",
    );
    expect(second.notified).toEqual([]);
    expect(second.skipped.sort()).toEqual(["a@b.com", "c@d.com"]);
  });

  test("an already-notified row is skipped, never re-sent", async () => {
    const { env } = fakeWaitlistDb([
      { email: "old@b.com", createdAt: 1, notifiedAt: 999 },
      { email: "new@b.com", createdAt: 2, notifiedAt: null },
    ]);
    const res = await sendAnnouncements(
      env,
      ["old@b.com", "new@b.com"],
      "https://dotflowy.com",
    );
    expect(res.notified).toEqual(["new@b.com"]);
    expect(res.skipped).toEqual(["old@b.com"]);
  });

  test("an address not on the waitlist is skipped (0-row claim, never emailed)", async () => {
    const { env } = fakeWaitlistDb([
      { email: "on@b.com", createdAt: 1, notifiedAt: null },
    ]);
    const res = await sendAnnouncements(
      env,
      ["stranger@x.com", "on@b.com"],
      "https://dotflowy.com",
    );
    expect(res.notified).toEqual(["on@b.com"]);
    expect(res.skipped).toEqual(["stranger@x.com"]);
  });

  test("normalizes + de-dupes input so one address is claimed at most once", async () => {
    const { env } = fakeWaitlistDb([
      { email: "a@b.com", createdAt: 1, notifiedAt: null },
    ]);
    const res = await sendAnnouncements(
      env,
      ["  A@B.com ", "a@b.com", ""],
      "https://dotflowy.com",
    );
    expect(res.notified).toEqual(["a@b.com"]);
    expect(res.skipped).toEqual([]);
  });
});

describe("pendingAnnounceEmails", () => {
  test("returns only un-notified rows, oldest first, honoring the limit", async () => {
    const { env } = fakeWaitlistDb([
      { email: "second@b.com", createdAt: 2, notifiedAt: null },
      { email: "done@b.com", createdAt: 1, notifiedAt: 500 },
      { email: "first@b.com", createdAt: 1, notifiedAt: null },
      { email: "third@b.com", createdAt: 3, notifiedAt: null },
    ]);
    expect(await pendingAnnounceEmails(env, null)).toEqual([
      "first@b.com",
      "second@b.com",
      "third@b.com",
    ]);
    expect(await pendingAnnounceEmails(env, 2)).toEqual([
      "first@b.com",
      "second@b.com",
    ]);
  });
});
