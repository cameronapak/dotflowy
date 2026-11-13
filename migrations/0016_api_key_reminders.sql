-- Delivery is per expiration, not per row: rotation preserves the key id.
ALTER TABLE capture_key ADD COLUMN reminderNotifiedExpiresAt INTEGER;
-- A bounded lease permits recovery after an interrupted send. The random token
-- fences late completions from an older claimant. No secret is stored here.
ALTER TABLE capture_key ADD COLUMN reminderClaimToken TEXT;
ALTER TABLE capture_key ADD COLUMN reminderClaimUntil INTEGER;
CREATE INDEX capture_key_expiration ON capture_key (expiresAt);
