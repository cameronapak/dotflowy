-- OAuth provider tables for the MCP endpoint (D1). The Better Auth `mcp`
-- plugin turns the Worker into an OAuth 2.1 authorization server so MCP
-- clients (Claude, inspector, etc.) can connect with a real token instead of
-- a session cookie. See docs/adr/0026-agent-native-mcp-server.md.
--
-- Written from better-auth@1.6.x's oidc-provider plugin schema (the mcp
-- plugin reuses it verbatim), following 0003's generated conventions
-- (booleans -> INTEGER, dates -> date, ids -> TEXT). If auth options/plugins
-- change the schema, add a new migration rather than editing this one.

CREATE TABLE "oauthApplication" (
  "id"           text NOT NULL PRIMARY KEY,
  "name"         text NOT NULL,
  "icon"         text,
  "metadata"     text,
  "clientId"     text NOT NULL UNIQUE,
  "clientSecret" text,
  "redirectUrls" text NOT NULL,
  "type"         text NOT NULL,
  "disabled"     integer,
  "userId"       text REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt"    date NOT NULL,
  "updatedAt"    date NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id"                    text NOT NULL PRIMARY KEY,
  "accessToken"           text NOT NULL UNIQUE,
  "refreshToken"          text NOT NULL UNIQUE,
  "accessTokenExpiresAt"  date NOT NULL,
  "refreshTokenExpiresAt" date NOT NULL,
  "clientId"              text NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId"                text REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes"                text NOT NULL,
  "createdAt"             date NOT NULL,
  "updatedAt"             date NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id"           text NOT NULL PRIMARY KEY,
  "clientId"     text NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId"       text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes"       text NOT NULL,
  "createdAt"    date NOT NULL,
  "updatedAt"    date NOT NULL,
  "consentGiven" integer NOT NULL
);

CREATE INDEX "oauthApplication_userId_idx" ON "oauthApplication" ("userId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
