-- Coordinates explicit trial setup, not entitlements. Stripe/Better Auth own
-- the subscription. Abandoned sessions can be replaced after their expiry.
CREATE TABLE pro_trial_checkout (
  userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  attemptId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  leaseUntil INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  usedAt INTEGER
);
