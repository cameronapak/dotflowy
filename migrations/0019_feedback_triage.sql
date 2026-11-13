-- Completion and internal comments are private admin triage, not customer replies.
-- Removing a report (including account deletion) also removes its internal notes.
ALTER TABLE feedback_submissions ADD COLUMN completed_at INTEGER;
CREATE TABLE feedback_comments (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 16 AND 64),
  submission_id INTEGER NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 5000),
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_comments_report ON feedback_comments(submission_id, created_at, id);
