import { expect, test } from "bun:test";

import {
  announceEmail,
  pendingAnnounceEmails,
  sendAnnouncements,
  type AnnounceEnv,
} from "./announce";

test("announceEmail carries the signup url and discloses that founding auto-renews, not lifetime", () => {
  // Ticket #294: the founding plan auto-renews after year three unless
  // cancelled, so the copy discloses the renewal AND denies the "lifetime"
  // framing. This is a disclosure obligation, not ordinary copy.
  const msg = announceEmail("https://dotflowy.com");
  for (const body of [msg.text, msg.html]) {
    expect(body).toContain("https://dotflowy.com");
    expect(body.toLowerCase()).toContain("auto-renew");
    expect(body.toLowerCase()).toContain("not a lifetime deal");
  }
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
  // SAFETY: the object below implements the D1 surface sendAnnouncements uses (prepare/bind/run/all) and nothing else; the single assertion stamps it as D1Database for the env.
  const db = Object.assign({} as D1Database, {
    prepare() {
      return {
        bind(...args: unknown[]) {
          return {
            run() {
              // UPDATE waitlist SET notifiedAt = ? WHERE email = ? AND notifiedAt IS NULL
              // SAFETY: this stub is bound only by that UPDATE, whose args are [notifiedAt: number, email: string].
              const [, email] = args as [number, string];
              const row = rows.find((r) => r.email === email);
              if (row && row.notifiedAt == null) {
                // SAFETY: args[0] is the notifiedAt timestamp the caller bound as a number.
                row.notifiedAt = args[0] as number;
                return Promise.resolve({ meta: { changes: 1 } });
              }
              return Promise.resolve({ meta: { changes: 0 } });
            },
            all() {
              // SELECT email FROM waitlist WHERE notifiedAt IS NULL ... [LIMIT ?]
              // SAFETY: the only optional bind on this SELECT is the LIMIT integer.
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
  });
  // EMAIL omitted: sendEmail falls back to console logging (never throws), so a
  // `notified` entry means the row was claimed and the send was attempted.
  const env: AnnounceEnv = { DB: db };
  return { env, rows };
}

test("sendAnnouncements claims each pending waitlist address once, so a re-run sends nothing", async () => {
  const { env, rows } = fakeWaitlistDb([
    { email: "second@b.com", createdAt: 2, notifiedAt: null },
    { email: "old@b.com", createdAt: 1, notifiedAt: 500 },
    { email: "first@b.com", createdAt: 1, notifiedAt: null },
    { email: "third@b.com", createdAt: 3, notifiedAt: null },
  ]);
  // Pending lists only un-notified rows, oldest first, honoring the limit.
  expect(await pendingAnnounceEmails(env, null)).toEqual([
    "first@b.com",
    "second@b.com",
    "third@b.com",
  ]);
  expect(await pendingAnnounceEmails(env, 2)).toEqual([
    "first@b.com",
    "second@b.com",
  ]);

  // Input is normalized and de-duped; an already-notified row and an address
  // not on the waitlist are skipped, never emailed.
  const res = await sendAnnouncements(
    env,
    [
      "  First@B.com ",
      "first@b.com",
      "",
      "second@b.com",
      "old@b.com",
      "stranger@x.com",
    ],
    "https://dotflowy.com",
  );
  expect(res.notified.sort()).toEqual(["first@b.com", "second@b.com"]);
  expect(res.skipped.sort()).toEqual(["old@b.com", "stranger@x.com"]);
  expect(rows.find((r) => r.email === "old@b.com")!.notifiedAt).toBe(500);
  expect(await pendingAnnounceEmails(env, null)).toEqual(["third@b.com"]);

  // A re-run is safe: the stamp makes every repeat a skip.
  const again = await sendAnnouncements(
    env,
    ["first@b.com", "second@b.com"],
    "https://dotflowy.com",
  );
  expect(again.notified).toEqual([]);
  expect(again.skipped.sort()).toEqual(["first@b.com", "second@b.com"]);
});
