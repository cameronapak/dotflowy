import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("the 1.7 reset invalidates legacy OAuth credentials but preserves identity and non-OAuth verification", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of ["0003_create_auth.sql", "0004_create_oauth.sql"])
      db.exec(await readFile(`migrations/${name}`, "utf8"));
    db.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.com', 1, '2026-01-01', '2026-01-01');
      INSERT INTO oauthApplication (id, name, clientId, redirectUrls, type, createdAt, updatedAt) VALUES ('app', 'App', 'old-client', 'https://client.example/callback', 'public', '2026-01-01', '2026-01-01');
      INSERT INTO oauthAccessToken (id, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, clientId, userId, scopes, createdAt, updatedAt) VALUES ('token', 'plaintext-access', 'plaintext-refresh', '2030-01-01', '2030-01-01', 'old-client', 'owner', 'openid', '2026-01-01', '2026-01-01');
      INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('session', '2030-01-01', 'browser-session', '2026-01-01', '2026-01-01', 'owner');
      INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('pending', 'consent-code', '{"clientId":"old-client","userId":"owner"}', '2030-01-01', '2026-01-01', '2026-01-01'), ('email', 'email-verification', 'owner', '2030-01-01', '2026-01-01', '2026-01-01');`);
    db.exec(await readFile("migrations/0023_better_auth_1_7.sql", "utf8"));
    expect(db.query("SELECT id FROM user").all()).toEqual([{ id: "owner" }]);
    expect(db.query("SELECT token FROM session").all()).toEqual([
      { token: "browser-session" },
    ]);
    expect(db.query("SELECT id FROM verification").all()).toEqual([
      { id: "email" },
    ]);
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE name = 'oauthApplication'")
        .all(),
    ).toEqual([]);
    for (const table of [
      "oauthClient",
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
      "oauthResource",
      "oauthClientResource",
      "oauthClientAssertion",
      "mcpGrant",
    ])
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec(`INSERT INTO oauthClient (id, clientId, redirectUris, userId) VALUES ('client', 'new-client', '["https://client.example/callback"]', 'owner');
      INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes) VALUES ('refresh', 'hash-refresh', 'new-client', 'owner', '2030-01-01', '2026-01-01', '["offline_access"]');
      INSERT INTO oauthAccessToken (id, token, clientId, userId, refreshId, expiresAt, createdAt, scopes) VALUES ('access', 'hash-access', 'new-client', 'owner', 'refresh', '2030-01-01', '2026-01-01', '["offline_access"]');
      DELETE FROM user WHERE id = 'owner';`);
    for (const table of [
      "oauthClient",
      "oauthRefreshToken",
      "oauthAccessToken",
      "mcpGrant",
      "session",
    ])
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
