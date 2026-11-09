import { Database, type SQLQueryBindings } from "bun:sqlite";
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

function waitlistFixture(
  rows: Array<{ email: string; createdAt: number; notifiedAt: number | null }>,
) {
  const sql = new Database(":memory:");
  sql.run(
    "CREATE TABLE waitlist (email TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, notifiedAt INTEGER)",
  );
  for (const row of rows)
    sql.run("INSERT INTO waitlist VALUES (?, ?, ?)", [
      row.email,
      row.createdAt,
      row.notifiedAt,
    ]);
  // SAFETY: this adapter exposes only the D1 methods used by this workflow.
  // SQLite, not the fixture, executes the production WHERE, ORDER BY and LIMIT.
  const db = {
    prepare(query: string) {
      const statement = sql.query(query);
      return {
        bind(...args: SQLQueryBindings[]) {
          return {
            async run() {
              return { meta: { changes: statement.run(...args).changes } };
            },
            async all() {
              return { results: statement.all(...args) };
            },
          };
        },
        async all() {
          return { results: statement.all() };
        },
      };
    },
  } as D1Database;
  const sent: string[] = [];
  const env: AnnounceEnv = {
    DB: db,
    EMAIL: {
      async send(message) {
        sent.push(String(message.to));
        return { messageId: `message-${sent.length}` };
      },
    },
  };
  return { env, sql, sent };
}

test("sendAnnouncements claims each pending waitlist address once, so a re-run sends nothing", async () => {
  const { env, sql, sent } = waitlistFixture([
    { email: "second@b.com", createdAt: 2, notifiedAt: null },
    { email: "old@b.com", createdAt: 1, notifiedAt: 500 },
    { email: "first@b.com", createdAt: 1, notifiedAt: null },
    { email: "third@b.com", createdAt: 3, notifiedAt: null },
  ]);
  try {
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
    expect(
      sql
        .query<{ notifiedAt: number }, []>(
          "SELECT notifiedAt FROM waitlist WHERE email = 'old@b.com'",
        )
        .get()?.notifiedAt,
    ).toBe(500);
    expect(sent).toEqual(["first@b.com", "second@b.com"]);
    expect(await pendingAnnounceEmails(env, null)).toEqual(["third@b.com"]);

    // A re-run is safe: the stamp makes every repeat a skip.
    const again = await sendAnnouncements(
      env,
      ["first@b.com", "second@b.com"],
      "https://dotflowy.com",
    );
    expect(again.notified).toEqual([]);
    expect(again.skipped.sort()).toEqual(["first@b.com", "second@b.com"]);
    expect(sent).toEqual(["first@b.com", "second@b.com"]);
  } finally {
    sql.close();
  }
});
