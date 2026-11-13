-- Only verified, paid checkout completions create a welcome. Renewals and
-- operator-comped subscription rows do not. Acknowledgment follows the account.
CREATE TABLE membership_welcome (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('unlimited', 'founding')),
  createdAt INTEGER NOT NULL,
  seenAt INTEGER
);
CREATE INDEX membership_welcome_user ON membership_welcome(userId, seenAt);
