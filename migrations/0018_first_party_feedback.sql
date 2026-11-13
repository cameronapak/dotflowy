-- Private first-party inbox. Identity is the server session's Better Auth id.
-- Account deletion also erases submissions; no outline data is collected.
CREATE TABLE feedback_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 64),
  payload_hash TEXT NOT NULL,
  plan TEXT NOT NULL CHECK(plan IN ('free', 'unlimited', 'founding')),
  kind TEXT NOT NULL CHECK(kind IN ('bug', 'idea', 'question')),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 5000),
  app_version TEXT NOT NULL CHECK(length(app_version) <= 64),
  browser TEXT CHECK(browser IS NULL OR length(browser) <= 512),
  route_category TEXT CHECK(route_category IS NULL OR route_category IN ('outline', 'settings', 'other')),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, request_id)
);
CREATE INDEX feedback_account_time ON feedback_submissions(user_id, created_at);
CREATE INDEX feedback_newest ON feedback_submissions(created_at DESC, id DESC);
