-- Capture-only credentials, separate from browser sessions and MCP OAuth.
CREATE TABLE capture_key (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  suffix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  credentialVersion TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUsedAt INTEGER,
  expiresAt INTEGER
);
CREATE INDEX capture_key_user ON capture_key (userId);
