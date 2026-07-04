-- Alpha waitlist: emails from people who want an invite while signup is
-- invite-gated (worker/auth.ts hooks.before + INVITE_CODES). Collected by the
-- public POST /api/waitlist route from the app's login screen and the landing
-- site. Owned data, deliberately not a third-party form service. `email` is
-- the primary key so re-submitting is a no-op (INSERT ... DO NOTHING), which
-- also keeps the endpoint non-enumerable — every valid request returns ok.
CREATE TABLE IF NOT EXISTS waitlist (
  email     TEXT PRIMARY KEY,   -- normalized (trimmed, lowercased)
  source    TEXT NOT NULL,      -- 'app' | 'landing'
  createdAt INTEGER NOT NULL
);
