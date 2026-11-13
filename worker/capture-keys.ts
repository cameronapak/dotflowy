/// <reference types="@cloudflare/workers-types" />

import {
  captureDigest,
  captureKeyExpiration,
  type ApiKeyCreateBody,
  type ApiKeyPermission,
  type ApiKeyRotateBody,
} from "./capture-input";

export interface CaptureKeyEntry {
  id: string;
  name: string;
  suffix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  permission: ApiKeyPermission;
}

function generateKeySecret() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return `dfk_${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createCaptureKey(
  db: D1Database,
  userId: string,
  input: typeof ApiKeyCreateBody.Type,
  now: number,
) {
  const credential = await db
    .prepare(
      "SELECT password FROM account WHERE userId = ? AND providerId = 'credential'",
    )
    .bind(userId)
    .first<{ password: string }>();
  if (!credential?.password) return null;
  const key = generateKeySecret();
  const entry: CaptureKeyEntry = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    suffix: key.slice(-4),
    createdAt: now,
    lastUsedAt: null,
    expiresAt: captureKeyExpiration(input.expiry, now),
    permission: input.permission ?? "capture",
  };
  await db
    .prepare(
      "INSERT INTO capture_key (id, userId, name, suffix, hash, credentialVersion, createdAt, expiresAt, permission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      entry.id,
      userId,
      entry.name,
      entry.suffix,
      await captureDigest(key),
      await captureDigest(credential.password),
      now,
      entry.expiresAt,
      entry.permission,
    )
    .run();
  return { key, entry };
}

/** Uncached live identity + password-version lookup: cleanup failure cannot
 *  revive keys after account deletion or a password reset/change. */
export async function authenticateCaptureKey(
  db: D1Database,
  authorization: string | null,
  now: number,
) {
  const match = /^Bearer ((?:dfc|dfk)_[0-9a-f]{64})$/i.exec(
    authorization ?? "",
  );
  if (!match) return null;
  const row = await db
    .prepare(
      `SELECT k.id, k.userId, k.credentialVersion, k.expiresAt, k.permission, a.password
     FROM capture_key k JOIN "user" u ON u.id = k.userId
     JOIN account a ON a.userId = u.id AND a.providerId = 'credential'
     WHERE k.hash = ?`,
    )
    .bind(await captureDigest(match[1]!))
    .first<{
      id: string;
      userId: string;
      credentialVersion: string;
      expiresAt: number | null;
      permission: ApiKeyPermission;
      password: string;
    }>();
  if (
    !row ||
    row.expiresAt === null ||
    row.expiresAt <= now ||
    row.credentialVersion !== (await captureDigest(row.password))
  )
    return null;
  return { id: row.id, userId: row.userId, permission: row.permission };
}

export async function rotateCaptureKey(
  db: D1Database,
  userId: string,
  input: typeof ApiKeyRotateBody.Type,
  now: number,
) {
  const credential = await db
    .prepare(
      "SELECT password FROM account WHERE userId = ? AND providerId = 'credential'",
    )
    .bind(userId)
    .first<{ password: string }>();
  if (!credential?.password) return null;
  const key = generateKeySecret();
  // One atomic replacement preserves the stored grant and invalidates the old
  // secret. A key can never be rotated across accounts or upgraded in place.
  const entry = await db
    .prepare(
      `UPDATE capture_key SET hash = ?, suffix = ?, credentialVersion = ?,
       createdAt = ?, expiresAt = ?, lastUsedAt = NULL
       WHERE id = ? AND userId = ?
       RETURNING id, name, suffix, createdAt, lastUsedAt, expiresAt, permission`,
    )
    .bind(
      await captureDigest(key),
      key.slice(-4),
      await captureDigest(credential.password),
      now,
      captureKeyExpiration(input.expiry, now),
      input.id,
      userId,
    )
    .first<CaptureKeyEntry>();
  return entry ? { key, entry } : null;
}

export async function listCaptureKeys(db: D1Database, userId: string) {
  const result = await db
    .prepare(
      "SELECT id, name, suffix, createdAt, lastUsedAt, expiresAt, permission FROM capture_key WHERE userId = ? ORDER BY createdAt DESC, id",
    )
    .bind(userId)
    .all<CaptureKeyEntry>();
  return result.results;
}

export async function revokeCaptureKeys(
  db: D1Database,
  userId: string,
  id?: string,
): Promise<void> {
  const statement =
    id === undefined
      ? db.prepare("DELETE FROM capture_key WHERE userId = ?").bind(userId)
      : db
          .prepare("DELETE FROM capture_key WHERE userId = ? AND id = ?")
          .bind(userId, id);
  await statement.run();
}
