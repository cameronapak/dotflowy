-- One key store. Existing dfc_ credentials keep capture-only permissions.
ALTER TABLE capture_key ADD COLUMN permission TEXT NOT NULL DEFAULT 'capture'
  CHECK (permission IN ('capture', 'read', 'write'));

-- The grace period starts when this migration runs, not at build time.
-- Preserve shorter lifetimes and already-expired keys. No secret is rotated.
UPDATE capture_key
SET expiresAt = (unixepoch('now') + 90 * 86400) * 1000
WHERE expiresAt IS NULL OR expiresAt > (unixepoch('now') + 90 * 86400) * 1000;
