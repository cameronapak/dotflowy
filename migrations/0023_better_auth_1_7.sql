-- Better Auth 1.7 MCP reset: existing agents reconnect once (ADR 0026).
-- No identity/session changes. Do not retain plaintext legacy credentials.
DELETE FROM verification WHERE json_valid(value) AND json_type(value, '$.clientId') IS NOT NULL;
DROP TABLE oauthAccessToken;
DROP TABLE oauthConsent;
DROP TABLE oauthApplication;

CREATE TABLE "oauthClient" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" integer DEFAULT 0,
  "skipConsent" integer,
  "enableEndSession" integer,
  "subjectType" text,
  "scopes" text CHECK ("scopes" IS NULL OR json_valid("scopes")),
  "clientCredentialsScopes" text DEFAULT '[]' CHECK ("clientCredentialsScopes" IS NULL OR json_valid("clientCredentialsScopes")),
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" date,
  "updatedAt" date,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text CHECK ("contacts" IS NULL OR json_valid("contacts")),
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" text NOT NULL CHECK ("redirectUris" IS NULL OR json_valid("redirectUris")),
  "postLogoutRedirectUris" text CHECK ("postLogoutRedirectUris" IS NULL OR json_valid("postLogoutRedirectUris")),
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" integer,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" text CHECK ("grantTypes" IS NULL OR json_valid("grantTypes")),
  "responseTypes" text CHECK ("responseTypes" IS NULL OR json_valid("responseTypes")),
  "requirePKCE" integer,
  "dpopBoundAccessTokens" integer DEFAULT 0,
  "referenceId" text,
  "metadata" text CHECK ("metadata" IS NULL OR json_valid("metadata"))
);
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

CREATE TABLE "oauthResource" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" text CHECK ("allowedScopes" IS NULL OR json_valid("allowedScopes")),
  "customClaims" text CHECK ("customClaims" IS NULL OR json_valid("customClaims")),
  "dpopBoundAccessTokensRequired" integer DEFAULT 0,
  "disabled" integer DEFAULT 0,
  "createdAt" date,
  "updatedAt" date,
  "policyVersion" integer DEFAULT 1,
  "metadata" text CHECK ("metadata" IS NULL OR json_valid("metadata"))
);


CREATE TABLE "oauthClientResource" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" text CHECK ("metadata" IS NULL OR json_valid("metadata")),
  "createdAt" date
);
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");

CREATE TABLE "oauthRefreshToken" (
  "id" text NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text CHECK ("resources" IS NULL OR json_valid("resources")),
  "requestedUserInfoClaims" text CHECK ("requestedUserInfoClaims" IS NULL OR json_valid("requestedUserInfoClaims")),
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "revoked" date,
  "rotatedAt" date,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" date,
  "authTime" date,
  "confirmation" text CHECK ("confirmation" IS NULL OR json_valid("confirmation")),
  "scopes" text NOT NULL CHECK ("scopes" IS NULL OR json_valid("scopes"))
);
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");

CREATE TABLE "oauthAccessToken" (
  "id" text NOT NULL PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" text CHECK ("resources" IS NULL OR json_valid("resources")),
  "requestedUserInfoClaims" text CHECK ("requestedUserInfoClaims" IS NULL OR json_valid("requestedUserInfoClaims")),
  "refreshId" text REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "revoked" date,
  "confirmation" text CHECK ("confirmation" IS NULL OR json_valid("confirmation")),
  "scopes" text NOT NULL CHECK ("scopes" IS NULL OR json_valid("scopes"))
);
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");

CREATE TABLE "oauthConsent" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" text CHECK ("resources" IS NULL OR json_valid("resources")),
  "requestedUserInfoClaims" text CHECK ("requestedUserInfoClaims" IS NULL OR json_valid("requestedUserInfoClaims")),
  "scopes" text NOT NULL CHECK ("scopes" IS NULL OR json_valid("scopes")),
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");

CREATE TABLE "oauthClientAssertion" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL
);


-- Revocation generations survive token deletion. A rotation that was already
-- in flight must not recreate a family after disconnect or replay cleanup.
CREATE TABLE mcpGrant (
  userId text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  clientId text NOT NULL REFERENCES oauthClient (clientId) ON DELETE CASCADE,
  epoch integer NOT NULL DEFAULT 0,
  PRIMARY KEY (userId, clientId)
);

CREATE TRIGGER oauthRefreshToken_deleted AFTER DELETE ON oauthRefreshToken BEGIN
  INSERT INTO mcpGrant (userId, clientId, epoch)
  SELECT OLD.userId, OLD.clientId, 1
  WHERE EXISTS (SELECT 1 FROM "user" WHERE id = OLD.userId)
    AND EXISTS (SELECT 1 FROM oauthClient WHERE clientId = OLD.clientId)
  ON CONFLICT(userId, clientId) DO UPDATE SET epoch = epoch + 1;
END;
