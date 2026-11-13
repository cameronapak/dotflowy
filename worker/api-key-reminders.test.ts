import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runApiKeyReminderSweep } from "./api-key-reminders";
import { captureDigest } from "./capture-input";
import { sendEmail, type EmailMessage } from "./email";

const NOW = Date.parse("2026-11-13T09:00:00Z");
const DAY = 86400_000;

async function fixture() {
  const sqlite = new Database(":memory:");
  // Minimal identity fixture; the key schema and all lifecycle SQL are real.
  // No foreign-key enforcement lets us retain orphan rows like failed cleanup.
  sqlite.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, emailVerified INTEGER);
    CREATE TABLE account (userId TEXT, providerId TEXT, password TEXT);`);
  for (const migration of [
    "0014_capture_keys.sql",
    "0015_scoped_api_keys.sql",
    "0016_api_key_reminders.sql",
  ]) {
    sqlite.exec(await Bun.file(`migrations/${migration}`).text());
  }
  // SAFETY: Only the D1 prepare/bind/first/all/run surface used by the public
  // sweep is adapted; SQLite executes the production statements unchanged.
  const DB = {
    prepare(sql: string) {
      const prepared = sqlite.prepare(sql);
      let values: Array<string | number | null> = [];
      const statement = {
        bind(...args: Array<string | number | null>) {
          values = args;
          return statement;
        },
        async first() {
          return prepared.get(...values);
        },
        async all() {
          return { results: prepared.all(...values) };
        },
        async run() {
          return { meta: { changes: prepared.run(...values).changes } };
        },
      };
      return statement;
    },
  } as D1Database;
  const messages: EmailMessage[] = [];
  let onSend = async (_message: EmailMessage) => {};
  // SAFETY: This fixture implements only the binding's send overload consumed
  // by sendEmail, and never connects to an actual email provider.
  const EMAIL = {
    async send(message: EmailMessage) {
      messages.push(message);
      await onSend(message);
      return { messageId: `fixture-${messages.length}` };
    },
  } as SendEmail;
  const env = {
    DB,
    EMAIL,
    BETTER_AUTH_URL: "https://self-hosted.example/auth",
  };
  const password = "fixture-password-hash";
  const version = await captureDigest(password);
  async function key(
    id: string,
    expiresAt: number | null,
    permission = "capture",
  ) {
    sqlite.run('INSERT INTO "user" VALUES (?, ?, 1)', [
      id,
      `${id}@example.com`,
    ]);
    sqlite.run("INSERT INTO account VALUES (?, 'credential', ?)", [
      id,
      password,
    ]);
    sqlite.run(
      `INSERT INTO capture_key
      (id, userId, name, suffix, hash, credentialVersion, createdAt, expiresAt, permission)
      VALUES (?, ?, ?, '1234', ?, ?, ?, ?, ?)`,
      [
        id,
        id,
        id,
        `secret-hash-${id}`,
        version,
        NOW - DAY,
        expiresAt,
        permission,
      ],
    );
  }
  function state(id: string) {
    return sqlite
      .query(`SELECT reminderNotifiedExpiresAt, reminderClaimToken, reminderClaimUntil
      FROM capture_key WHERE id = ?`)
      .get(id);
  }
  return {
    sqlite,
    env,
    messages,
    key,
    state,
    onSend(fn: typeof onSend) {
      onSend = fn;
    },
  };
}

test("sweep applies the seven-day window, live identity/password gates, canonical links and HTML escaping", async () => {
  const f = await fixture();
  try {
    await f.key("edge", NOW + 7 * DAY, "read");
    await f.key("soon", NOW + DAY, "write");
    await f.key("near", NOW + 60_000);
    await f.key("outside", NOW + 7 * DAY + 1);
    await f.key("expired", NOW);
    await f.key("past", NOW - 1);
    await f.key("indefinite", null);
    await f.key("unverified", NOW + DAY);
    await f.key("changed-password", NOW + DAY);
    await f.key("deleted", NOW + DAY);
    await f.key("no-credential", NOW + DAY);
    f.sqlite.run('UPDATE "user" SET emailVerified = 0 WHERE id = ?', [
      "unverified",
    ]);
    f.sqlite.run("UPDATE account SET password = 'changed' WHERE userId = ?", [
      "changed-password",
    ]);
    f.sqlite.run('DELETE FROM "user" WHERE id = ?', ["deleted"]);
    f.sqlite.run("DELETE FROM account WHERE userId = ?", ["no-credential"]);
    f.sqlite.run("UPDATE capture_key SET name = ? WHERE id = 'edge'", [
      "<img src=x onerror=\"bad\"> & 'quoted'",
    ]);

    await runApiKeyReminderSweep(f.env, NOW);
    expect(f.messages.map((m) => m.to).sort()).toEqual([
      "edge@example.com",
      "near@example.com",
      "soon@example.com",
    ]);
    const message = f.messages.find((m) => m.to === "edge@example.com")!;
    expect(message.html).toContain(
      "&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &#39;quoted&#39;",
    );
    expect(message.html).not.toContain("<img");
    for (const body of [message.html, message.text]) {
      expect(body).toContain("Read-only");
      expect(body).toContain("2026-11-20T09:00:00.000Z");
      expect(body).toContain(
        "https://self-hosted.example/settings#capture-keys",
      );
      expect(body).not.toContain("secret-hash");
      expect(body).not.toContain("fixture-password");
    }
    expect(f.messages.find((m) => m.to === "soon@example.com")!.text).toContain(
      "Read and write",
    );
    expect(f.messages.find((m) => m.to === "near@example.com")!.text).toContain(
      "Capture only",
    );
    expect(f.state("edge")).toEqual({
      reminderNotifiedExpiresAt: NOW + 7 * DAY,
      reminderClaimToken: null,
      reminderClaimUntil: null,
    });
    await runApiKeyReminderSweep(f.env, NOW);
    expect(f.messages).toHaveLength(3);
    await runApiKeyReminderSweep(f.env, NOW + 1);
    expect(f.messages).toHaveLength(4); // one millisecond outside now enters.
  } finally {
    f.sqlite.close();
  }
});

test("binding failures and missing configuration do not stamp delivered and remain retryable", async () => {
  const f = await fixture();
  try {
    await f.key("retry", NOW + DAY);
    await runApiKeyReminderSweep({ ...f.env, EMAIL: undefined }, NOW);
    await runApiKeyReminderSweep({ ...f.env, BETTER_AUTH_URL: undefined }, NOW);
    expect(f.messages).toHaveLength(0);
    f.onSend(async () => {
      throw new Error("fixture delivery failure");
    });
    await runApiKeyReminderSweep(f.env, NOW);
    expect(f.state("retry")).toEqual({
      reminderNotifiedExpiresAt: null,
      reminderClaimToken: null,
      reminderClaimUntil: null,
    });
    f.onSend(async () => {});
    await runApiKeyReminderSweep(f.env, NOW);
    expect(f.messages).toHaveLength(2);
    expect(f.state("retry")).toEqual({
      reminderNotifiedExpiresAt: NOW + DAY,
      reminderClaimToken: null,
      reminderClaimUntil: null,
    });
    expect(
      await sendEmail(
        {},
        {
          to: "fixture@example.com",
          subject: "fixture",
          html: "fixture",
          text: "fixture",
        },
      ),
    ).toEqual({ status: "simulated" });
  } finally {
    f.sqlite.close();
  }
});

test("concurrent sweeps claim once, and rotation during send cannot stamp the new expiry", async () => {
  const f = await fixture();
  try {
    await f.key("rotate", NOW + DAY);
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.onSend(async () => {
      entered();
      await held;
    });
    const first = runApiKeyReminderSweep(f.env, NOW);
    await sending;
    await Promise.all([
      runApiKeyReminderSweep(f.env, NOW),
      runApiKeyReminderSweep(f.env, NOW),
    ]);
    expect(f.messages).toHaveLength(1);
    f.sqlite.run(
      `UPDATE capture_key SET hash = 'rotated', suffix = '5678',
      createdAt = ?, expiresAt = ?, lastUsedAt = NULL WHERE id = 'rotate'`,
      [NOW, NOW + 30 * DAY],
    );
    release();
    await first;
    expect(f.state("rotate")).toMatchObject({
      reminderNotifiedExpiresAt: null,
    });
    f.onSend(async () => {});
    await runApiKeyReminderSweep(f.env, NOW + 23 * DAY);
    expect(f.messages).toHaveLength(2);
    expect(f.state("rotate")).toEqual({
      reminderNotifiedExpiresAt: NOW + 30 * DAY,
      reminderClaimToken: null,
      reminderClaimUntil: null,
    });
    await runApiKeyReminderSweep(f.env, NOW + 24 * DAY);
    expect(f.messages).toHaveLength(2);
    // Rotation after a completed reminder also becomes eligible independently.
    f.sqlite.run("UPDATE capture_key SET expiresAt = ? WHERE id = 'rotate'", [
      NOW + 60 * DAY,
    ]);
    await runApiKeyReminderSweep(f.env, NOW + 53 * DAY);
    expect(f.messages).toHaveLength(3);
    await f.key("simultaneous", NOW + DAY);
    await Promise.all([
      runApiKeyReminderSweep(f.env, NOW),
      runApiKeyReminderSweep(f.env, NOW),
      runApiKeyReminderSweep(f.env, NOW),
    ]);
    expect(f.messages).toHaveLength(4);
  } finally {
    f.sqlite.close();
  }
});

test("an interrupted claim expires and late completion cannot clear or stamp its successor", async () => {
  const f = await fixture();
  try {
    await f.key("interrupted", NOW + DAY);
    f.sqlite.run(
      `UPDATE capture_key SET reminderClaimToken = 'dead-worker',
      reminderClaimUntil = ? WHERE id = 'interrupted'`,
      [NOW + 300_000],
    );
    await runApiKeyReminderSweep(f.env, NOW + 299_999);
    expect(f.messages).toHaveLength(0);
    await runApiKeyReminderSweep(f.env, NOW + 300_000);
    expect(f.messages).toHaveLength(1);
    expect(f.state("interrupted")).toEqual({
      reminderNotifiedExpiresAt: NOW + DAY,
      reminderClaimToken: null,
      reminderClaimUntil: null,
    });

    await f.key("late", NOW + 2 * DAY);
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.onSend(async () => {
      entered();
      await held;
    });
    const old = runApiKeyReminderSweep(f.env, NOW);
    await sending;
    // Simulate recovery after the old worker's lease elapsed. Leave the new
    // claimant in-flight to prove old completion does not release its lease.
    f.sqlite.run(
      `UPDATE capture_key SET reminderClaimToken = 'successor',
      reminderClaimUntil = ? WHERE id = 'late'`,
      [NOW + 600_000],
    );
    release();
    await old;
    expect(f.state("late")).toEqual({
      reminderNotifiedExpiresAt: null,
      reminderClaimToken: "successor",
      reminderClaimUntil: NOW + 600_000,
    });
  } finally {
    f.sqlite.close();
  }
});
