import type { Page, Route } from "@playwright/test";

// A node as the test author cares about it -- structural fields only. Everything
// the schema also requires (isTask/completed/collapsed/timestamps) is filled in
// with inert defaults by seedOutline so each test only states what matters.
export interface SeedNode {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  collapsed?: boolean;
  completed?: boolean;
  isTask?: boolean;
  /** Epoch ms when bookmarked; omit/null for an un-bookmarked node. */
  bookmarkedAt?: number | null;
}

/** A full node row as the /api/nodes Worker speaks it -- real booleans, all
 *  fields present. Mirrors the client `Node` type (src/data/schema.ts). */
interface ApiNode {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toNode(n: SeedNode): ApiNode {
  return {
    id: n.id,
    parentId: n.parentId,
    prevSiblingId: n.prevSiblingId,
    text: n.text,
    isTask: n.isTask ?? false,
    completed: n.completed ?? false,
    collapsed: n.collapsed ?? false,
    bookmarkedAt: n.bookmarkedAt ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Seed a known outline by intercepting the `/api/nodes` Worker with an
 * in-memory mock, so the app's TanStack DB query collection loads exactly this
 * tree and the editor's seed-if-empty effect sees a non-empty store and stays
 * out of the way.
 *
 * Since the D1 move (ADR 0023) the app reads nodes from the Worker, not
 * localStorage -- so the old localStorage seed was a no-op. This mock mirrors
 * `worker/index.ts`'s contract exactly:
 *   - GET    -> the COMPLETE node set (the queryFn treats it as authoritative)
 *   - POST   -> upsert `{ nodes }`
 *   - PATCH  -> apply `{ updates: [{ id, changes }] }`
 *   - DELETE -> drop `{ ids }`
 * so the real `collection.ts` -> `api.ts` query/mutation path is exercised end
 * to end; only D1 is swapped for a Map. The Worker's own SQL is covered by
 * `typecheck:worker` plus manual verification (docs/DECISIONS.md (D1 sync)), not here.
 *
 * The store is scoped to this test's `page`. Playwright gives each test its own
 * page/context, so two tests never share state -- stronger isolation than a
 * single shared local D1 would give under `fullyParallel`. Register before
 * `page.goto(...)` (every spec does) so the collection's first GET is mocked.
 */
export async function seedOutline(page: Page, nodes: SeedNode[]): Promise<void> {
  const store = new Map<string, ApiNode>();
  for (const n of nodes) store.set(n.id, toNode(n));

  const reply = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });

  // The app is gated behind a Better Auth session (root AuthGate). The editor
  // only mounts once `useSession()` resolves to a session, so mock the
  // get-session endpoint with a fixed authed user. Without this the specs would
  // see the login screen instead of the outline. (Auth itself is verified
  // live against `wrangler dev`, not here.)
  await page.route(
    (url) => url.pathname === "/api/auth/get-session",
    (route) =>
      reply(route, {
        session: {
          id: "test-session",
          userId: "test-user",
          token: "test-token",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        user: {
          id: "test-user",
          email: "test@example.com",
          name: "Test User",
          emailVerified: true,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
  );

  await page.route(
    (url) => url.pathname === "/api/nodes",
    async (route) => {
      const req = route.request();
      switch (req.method()) {
        case "GET":
          return reply(route, [...store.values()]);
        case "POST": {
          const { nodes: incoming } = req.postDataJSON() as { nodes: ApiNode[] };
          for (const n of incoming ?? []) store.set(n.id, n);
          return reply(route, { ok: true });
        }
        case "PATCH": {
          const { updates } = req.postDataJSON() as {
            updates: { id: string; changes: Partial<ApiNode> }[];
          };
          for (const u of updates ?? []) {
            const cur = store.get(u.id);
            if (cur) store.set(u.id, { ...cur, ...u.changes });
          }
          return reply(route, { ok: true });
        }
        case "DELETE": {
          const { ids } = req.postDataJSON() as { ids: string[] };
          for (const id of ids ?? []) store.delete(id);
          return reply(route, { ok: true });
        }
        default:
          return route.fulfill({ status: 405, body: "{}" });
      }
    },
  );

  // The plugin side-collections (tag colors, daily index) are now D1-backed too
  // (ADR 0024), so every spec's app load GETs /api/kv per collection and the
  // daily specs WRITE through it (a failed write would roll back the optimistic
  // insert). Mock the generic kv store per collection namespace, starting empty.
  const kv = new Map<string, Map<string, unknown>>();
  const ns = (collection: string) => {
    let m = kv.get(collection);
    if (!m) kv.set(collection, (m = new Map()));
    return m;
  };

  await page.route(
    (url) => url.pathname === "/api/kv",
    async (route) => {
      const req = route.request();
      const collection = new URL(req.url()).searchParams.get("collection") ?? "";
      const m = ns(collection);
      switch (req.method()) {
        case "GET":
          return reply(route, [...m.values()]);
        case "POST": {
          // `?op=claim` mirrors the DO's atomic get-or-create: insert only if
          // the key is absent, return the authoritative value (pre-existing
          // wins). The per-page Map IS the single source, so two claims for the
          // same key here resolve to one winner -- exactly as the real DO does.
          if (new URL(req.url()).searchParams.get("op") === "claim") {
            const { key, value } = req.postDataJSON() as {
              key: string;
              value: unknown;
            };
            if (!m.has(key)) m.set(key, value);
            return reply(route, { value: m.get(key) });
          }
          const { rows } = req.postDataJSON() as {
            rows: { key: string; value: unknown }[];
          };
          for (const r of rows ?? []) m.set(r.key, r.value);
          return reply(route, { ok: true });
        }
        case "DELETE": {
          const { keys } = req.postDataJSON() as { keys: string[] };
          for (const k of keys ?? []) m.delete(k);
          return reply(route, { ok: true });
        }
        default:
          return route.fulfill({ status: 405, body: "{}" });
      }
    },
  );

  // The live client loads the outline over a WebSocket (/api/sync), not a GET --
  // realtime sync (docs/realtime-push-plan.md). The app sends a `hello`; reply
  // with a full snapshot from the seeded store so the collection becomes ready
  // and the editor mounts. Single-page specs need no live deltas: optimistic
  // mutations update the UI and writes still persist through the REST mock above,
  // so the socket only has to bootstrap. Not calling connectToServer() keeps this
  // fully mocked -- there is no real Worker in e2e. (The real socket is exercised
  // by a live two-context test against wrangler dev, not here.)
  await page.routeWebSocket(
    (url) => url.pathname === "/api/sync",
    (ws) => {
      ws.onMessage(() =>
        ws.send(
          JSON.stringify({
            type: "snapshot",
            seq: 0,
            nodes: [...store.values()],
          }),
        ),
      );
    },
  );
}

/**
 * The standard fixture used by the navigation specs:
 *
 *   - Alpha            (alpha)
 *       - Alpha one    (alpha-1)
 *       - Alpha two    (alpha-2)
 *   - Bravo            (bravo)
 *   - Charlie          (charlie)
 *
 * Visible display order when nothing is collapsed:
 *   alpha, alpha-1, alpha-2, bravo, charlie
 */
export const STANDARD_TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "charlie", parentId: null, prevSiblingId: "bravo", text: "Charlie" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  { id: "alpha-2", parentId: "alpha", prevSiblingId: "alpha-1", text: "Alpha two" },
];
