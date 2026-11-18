-- Earned time, not money or plugin-owned subscription rows. All times are ms.
CREATE TABLE pro_reward (
  id TEXT PRIMARY KEY,
  userId TEXT REFERENCES user(id) ON DELETE CASCADE,
  reportId INTEGER UNIQUE REFERENCES feedback_submissions(id) ON DELETE CASCADE,
  bug TEXT NOT NULL,
  issuer TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  codeHash TEXT UNIQUE,
  claimBy INTEGER NOT NULL,
  claimedAt INTEGER,
  state TEXT NOT NULL CHECK(state IN ('issued','pending','scheduled','applied','review','revoked')),
  message TEXT NOT NULL DEFAULT '',
  subscriptionId TEXT,
  originalEnd INTEGER,
  startsAt INTEGER,
  endsAt INTEGER,
  priceId TEXT,
  attemptedAt INTEGER,
  gift INTEGER NOT NULL DEFAULT 0 CHECK(gift IN (0,1)),
  UNIQUE(userId, bug)
);
CREATE INDEX pro_reward_account ON pro_reward(userId, state, endsAt);
CREATE INDEX pro_reward_history ON pro_reward(createdAt DESC, id DESC) WHERE codeHash IS NOT NULL;
-- Serializes grants, reconciliation, and retries across Worker isolates.
CREATE TABLE pro_reward_lock (
  userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  untilAt INTEGER NOT NULL
);
CREATE TABLE pro_reward_attempt (
  userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  windowAt INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
-- A checkout reservation closes the grant-versus-checkout race. Merely opening
-- checkout never consumes gifted access. Retries reuse the same fixed params.
CREATE TABLE membership_checkout (
  userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  attemptId TEXT NOT NULL,
  plan TEXT NOT NULL,
  annual INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  giftEnd INTEGER
);
