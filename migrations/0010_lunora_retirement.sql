CREATE TABLE IF NOT EXISTS lunora_retirement (
  userId TEXT PRIMARY KEY NOT NULL,
  migrationId TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  classification TEXT,
  result TEXT,
  startedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  completedAt INTEGER,
  classicSnapshotKey TEXT,
  classicSnapshotHash TEXT,
  lunoraSnapshotKey TEXT,
  lunoraSnapshotHash TEXT,
  counts TEXT,
  failureReason TEXT
);

CREATE TABLE IF NOT EXISTS lunora_retirement_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migrationId TEXT NOT NULL,
  userId TEXT NOT NULL,
  attemptedAt INTEGER NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  failureReason TEXT
);

CREATE INDEX IF NOT EXISTS idx_lunora_retirement_attempt_migration
  ON lunora_retirement_attempt(migrationId, id);
