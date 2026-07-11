// Pure logic for saved filter queries (ADR 0048). Dependency-free on purpose --
// the `tag-colors.ts`/`highlight.ts` discipline: no collection imports, no DOM,
// so it stays bun-testable and importing it never drags the TanStack DB
// collection stack into a unit test. The collection + reactive reads live in
// `saved-queries.ts`, which leans on these helpers.

/** One saved filter query. `name` defaults to the query text at save time; the
 *  user can rename it later (ADR 0048 decision 4). `query` is the raw `?q=`
 *  string. Newest-first ordering is by `createdAt` (decision 6). */
export interface SavedQueryRow {
  id: string;
  name: string;
  query: string;
  createdAt: number;
}

/** Canonical form for equality + matching: trimmed. Applied consistently so the
 *  pin's pressed-state match isn't whitespace-flaky (ADR 0048). */
export function normalizeQuery(query: string): string {
  return query.trim();
}

/** The default name for a saved query -- the query text itself (ADR 0048
 *  decision 3: "click = instant save, no naming interruption"). */
export function defaultQueryName(query: string): string {
  return normalizeQuery(query);
}

/** Saved queries newest-first (createdAt desc), the sole ordering until manual
 *  reordering ships (ADR 0048 decision 6). Ties break on id for determinism. */
export function sortSavedNewestFirst(
  rows: readonly SavedQueryRow[],
): SavedQueryRow[] {
  return [...rows].sort(
    (a, b) =>
      b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The saved row whose query matches `query` (normalized both sides), or
 *  undefined. Drives the pin's pressed state and the unsave path. */
export function findSavedQuery(
  rows: readonly SavedQueryRow[],
  query: string,
): SavedQueryRow | undefined {
  const q = normalizeQuery(query);
  if (!q) return undefined;
  return rows.find((r) => normalizeQuery(r.query) === q);
}

/** Whether this exact (trimmed) query string is already saved. An empty query
 *  is never "saved". */
export function isQuerySaved(
  rows: readonly SavedQueryRow[],
  query: string,
): boolean {
  return findSavedQuery(rows, query) !== undefined;
}

/** Token match for the Cmd+K "Saved filters" group (ADR 0048 decision 2:
 *  "matchable by name while typing"). Every whitespace token of `q` must appear
 *  in the row's name or query -- mirrors the switcher's `matchAction`. */
export function matchSavedQuery(q: string, row: SavedQueryRow): boolean {
  const hay = `${row.name} ${row.query}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}
