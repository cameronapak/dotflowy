-- Better Auth identity tables (D1). Better Auth owns identity; each user's
-- outline + side-collections live in their per-user Durable Object, keyed by
-- the stable `user.id` minted here. See docs/DECISIONS.md (the auth gate).
--
-- Generated verbatim from better-auth@1.6.x getMigrations() for the
-- emailAndPassword config (booleans -> INTEGER, ids -> TEXT). If auth
-- options/plugins change the schema, re-generate and add a new migration
-- rather than editing this one.
CREATE TABLE "user" (
  "id"            text NOT NULL PRIMARY KEY,
  "name"          text NOT NULL,
  "email"         text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image"         text,
  "createdAt"     date NOT NULL,
  "updatedAt"     date NOT NULL
);

CREATE TABLE "session" (
  "id"        text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token"     text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id"                    text NOT NULL PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  date,
  "refreshTokenExpiresAt" date,
  "scope"                 text,
  "password"              text,
  "createdAt"             date NOT NULL,
  "updatedAt"             date NOT NULL
);

CREATE TABLE "verification" (
  "id"         text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value"      text NOT NULL,
  "expiresAt"  date NOT NULL,
  "createdAt"  date NOT NULL,
  "updatedAt"  date NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
