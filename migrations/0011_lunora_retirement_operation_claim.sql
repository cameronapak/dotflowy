-- Invocation ownership is distinct from the reusable migration id.
-- No expiry: an interrupted executor must be confirmed stopped before recovery.
ALTER TABLE lunora_retirement ADD COLUMN activeOperationId TEXT;
ALTER TABLE lunora_retirement ADD COLUMN activeOperationStartedAt INTEGER;
