-- 0012 is reserved by the separate consent/admin scaffold PR.
-- A manual preserve-Classic operation never uses the replacement migration policy.
ALTER TABLE lunora_retirement ADD COLUMN policy TEXT NOT NULL DEFAULT 'lunora-to-classic-v1';
ALTER TABLE lunora_retirement ADD COLUMN recoveryManifestKey TEXT;
ALTER TABLE lunora_retirement ADD COLUMN recoveryManifestHash TEXT;
