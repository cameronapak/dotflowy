-- Outbound support replies are distinct from private internal comments.
-- Claim each send before contacting email; never automatically resend an uncertain claim.
CREATE TABLE feedback_replies (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 16 AND 64),
  submission_id INTEGER NOT NULL REFERENCES feedback_submissions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 5000),
  status TEXT NOT NULL CHECK(status IN ('sending', 'accepted', 'unknown', 'simulated')),
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX feedback_replies_report ON feedback_replies(submission_id, created_at, id);
