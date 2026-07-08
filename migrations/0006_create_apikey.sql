-- Personal API keys (Better Auth `@better-auth/api-key` plugin). Used only for
-- headless quick-capture (`POST /api/quick-add` with `x-api-key`); keys do NOT
-- unlock the rest of the session-gated REST surface (plugin option
-- enableSessionForAPIKeys stays false). See issue #96.
--
-- Schema from better-auth@1.6.x api-key plugin reference, following 0003/0004
-- conventions (booleans -> INTEGER, dates -> date, ids -> TEXT). If the plugin
-- schema changes, add a new migration rather than editing this one.

CREATE TABLE "apikey" (
  "id"                  text NOT NULL PRIMARY KEY,
  "configId"            text NOT NULL,
  "name"                text,
  "start"               text,
  "prefix"              text,
  "key"                 text NOT NULL,
  "referenceId"         text NOT NULL,
  "refillInterval"      integer,
  "refillAmount"        integer,
  "lastRefillAt"        date,
  "enabled"             integer,
  "rateLimitEnabled"    integer,
  "rateLimitTimeWindow" integer,
  "rateLimitMax"        integer,
  "requestCount"        integer,
  "remaining"           integer,
  "lastRequest"         date,
  "expiresAt"           date,
  "createdAt"           date NOT NULL,
  "updatedAt"           date NOT NULL,
  "permissions"         text,
  "metadata"            text
);

CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
