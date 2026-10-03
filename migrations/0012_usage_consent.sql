-- No collector is wired by this migration. See ADR 0063.
CREATE TABLE usage_consent (
  userId TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  policyVersion TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('accepted', 'declined')),
  generation TEXT NOT NULL,
  decidedAt INTEGER NOT NULL
);

-- Presence only, not individual events or edit counts.
CREATE TABLE usage_daily (
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('classic', 'experimental')),
  source TEXT NOT NULL CHECK (source IN ('browser', 'mcp')),
  activity TEXT NOT NULL CHECK (activity IN ('opened', 'edited')),
  CHECK (activity <> 'opened' OR source = 'browser'),
  PRIMARY KEY (userId, day, backend, source, activity)
);
CREATE INDEX usage_daily_day ON usage_daily(day);
