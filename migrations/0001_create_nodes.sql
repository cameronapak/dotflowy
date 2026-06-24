-- Outline nodes, one row per bullet. Mirrors the Node type in
-- src/data/schema.ts; booleans are stored as INTEGER 0/1, timestamps as
-- INTEGER epoch-ms. `owner` scopes every row to the authenticated user
-- (Cloudflare Access email). See docs/adr/0023.
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  parentId      TEXT,
  prevSiblingId TEXT,
  text          TEXT NOT NULL,
  isTask        INTEGER NOT NULL DEFAULT 0,
  completed     INTEGER NOT NULL DEFAULT 0,
  collapsed     INTEGER NOT NULL DEFAULT 0,
  bookmarkedAt  INTEGER,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL
);

-- Every read is scoped by owner; the parent index speeds the tree rebuild.
CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(owner);
CREATE INDEX IF NOT EXISTS idx_nodes_owner_parent ON nodes(owner, parentId);
