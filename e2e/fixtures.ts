import type { Page, Route, WebSocketRoute } from "@playwright/test";

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
  /** Source node id this is a mirror of (ADR 0022); omit/null for a normal node. */
  mirrorOf?: string | null;
  /** Provenance: agent harness name if created via MCP; omit/null for human. */
  origin?: string | null;
  /** Node kind (ADR 0045); omit/null for a bullet-or-task. */
  kind?: "paragraph" | null;
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
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
}

/** One op in a change frame, as the DO broadcasts and the batch POST carries.
 *  Mirrors `ChangeOp` in src/data/realtime.ts. */
type ApiChangeOp =
  | { op: "insert"; value: ApiNode }
  | { op: "update"; value: ApiNode }
  | { op: "delete"; key: string };

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
    mirrorOf: n.mirrorOf ?? null,
    createdAt: 0,
    updatedAt: 0,
    // Every seeded node is "human" (null) — the origin marker only lights up for
    // MCP-created nodes, which the e2e mock never produces. Required by the wire
    // schema the client decodes inbound frames against, so it must be present.
    origin: n.origin ?? null,
    // A seeded node is a bullet-or-task unless the spec says otherwise. Required
    // by the wire schema the client decodes inbound frames against (ADR 0045),
    // so it must be present on every row the mock emits.
    kind: n.kind ?? null,
  };
}

/**
 * Seed a known outline by intercepting the `/api/nodes` Worker and `/api/sync`
 * WebSocket with in-memory mocks, so the app's custom-sync collection loads
 * exactly this tree and the editor's seed-if-empty effect sees a non-empty store
 * and stays out of the way.
 *
 * The app reads nodes over a WebSocket (`/api/sync`), not a GET — writes still
 * ride the REST mock below. This mirrors `worker/index.ts`'s contract:
 *   - GET/POST/PATCH/DELETE `/api/nodes` — mutation path (unchanged)
 *   - WS `/api/sync` — `hello` → `snapshot` from the seeded store
 * so the real `collection.ts` → `api.ts` + `realtime.ts` path is exercised end
 * to end; only the DO is swapped for a Map. The Worker's own SQL is covered by
 * `typecheck:worker` plus manual verification (docs/adr/0008-sync-via-a-per-user-durable-object.md), not here.
 *
 * The store is scoped to this test's `page`. Playwright gives each test its own
 * page/context, so two tests never share state. Register before `page.goto(...)`
 * (every spec does) so the collection's first sync is mocked.
 */
export async function seedOutline(
  page: Page,
  nodes: SeedNode[],
  opts: {
    echoDelayMs?: number;
    postDelayMs?: number;
    /** Split a structural batch's echo into N frames (chunked ops, consecutive
     *  seqs, staggered by echoDelayMs each), replying with the FINAL seq —
     *  mirrors the DO's chunked recordChange (worker/outline-do.ts, issue
     *  #124), which commits a >500-op batch as multiple consecutive-seq
     *  changelog rows and echoes them as multiple frames. */
    echoChunks?: number;
    /** Pre-seed plugin side-collections, keyed by collection namespace (e.g.
     *  `"daily-index"`). Each row is stored as `key -> value` exactly as a write
     *  would land, so the app's first GET returns it. Lets a spec start with a
     *  side-collection already populated (e.g. an existing Daily container) to
     *  exercise the async-load path that a fresh, navigation-free load hits. */
    kv?: Record<string, { key: string; value: unknown }[]>;
    /** Stamp `serverVersion` onto the `snapshot` frame, as the real DO does
     *  (ADR 0046). Omitted by default, which is faithful to a DO that predates
     *  the field AND keeps every other spec free of an update toast; pass a
     *  version different from package.json's to exercise the stale-tab path. */
    serverVersion?: string;
  } = {},
): Promise<void> {
  const echoDelayMs = opts.echoDelayMs ?? 0;
  // Delay only the structural-batch POST *response* (not its echo). Opens a
  // window to prove the client serializes batches: a second batch must not be
  // in flight until the first response lands. Mirrors a slow DO round-trip.
  const postDelayMs = opts.postDelayMs ?? 0;
  const store = new Map<string, ApiNode>();
  for (const n of nodes) store.set(n.id, toNode(n));

  // Realtime-faithful mock of the DO: every mutation commits a monotonic change
  // frame and is broadcast back. We mirror that -- each write bumps `seq`,
  // applies to `store`, and echoes a `change` frame over the open sync socket,
  // optionally after `echoDelayMs` (which reproduces the gap between an op's HTTP
  // response and its WS echo). The structural batch path additionally returns its
  // seq so the client can hold its optimistic overlay until the echo lands.
  let seq = 0;
  let socket: WebSocketRoute | null = null;
  const broadcast = (ops: ApiChangeOp[], extraDelayMs = 0): number => {
    seq += 1;
    const at = seq;
    const frame = JSON.stringify({ type: "change", seq: at, ops });
    const deliver = () => socket?.send(frame);
    const delay = echoDelayMs + extraDelayMs;
    if (delay > 0) setTimeout(deliver, delay);
    else deliver();
    return at;
  };
  const echoChunks = opts.echoChunks ?? 1;

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
          const body = req.postDataJSON() as {
            ops?: ApiChangeOp[];
            nodes?: ApiNode[];
          };
          // Atomic structural batch: apply every op, commit ONE frame, reply with
          // its seq (mirrors the DO's applyBatch -> { seq }).
          if (body.ops) {
            for (const op of body.ops) {
              if (op.op === "delete") store.delete(op.key);
              else store.set(op.value.id, op.value);
            }
            let at: number;
            if (echoChunks > 1 && body.ops.length > 1) {
              const size = Math.ceil(body.ops.length / echoChunks);
              at = 0;
              for (let i = 0; i * size < body.ops.length; i++) {
                at = broadcast(
                  body.ops.slice(i * size, (i + 1) * size),
                  i * echoDelayMs,
                );
              }
            } else {
              at = broadcast(body.ops);
            }
            if (postDelayMs > 0) {
              await new Promise((r) => setTimeout(r, postDelayMs));
            }
            return reply(route, { seq: at });
          }
          // Legacy upsert path (the first-run seed).
          const ops: ApiChangeOp[] = (body.nodes ?? []).map((n) => ({
            op: "insert",
            value: n,
          }));
          for (const n of body.nodes ?? []) store.set(n.id, n);
          if (ops.length) broadcast(ops);
          return reply(route, { ok: true });
        }
        case "PATCH": {
          const { updates } = req.postDataJSON() as {
            updates: { id: string; changes: Partial<ApiNode> }[];
          };
          const ops: ApiChangeOp[] = [];
          for (const u of updates ?? []) {
            const cur = store.get(u.id);
            if (cur) {
              const next = { ...cur, ...u.changes };
              store.set(u.id, next);
              ops.push({ op: "update", value: next });
            }
          }
          if (ops.length) broadcast(ops);
          return reply(route, { ok: true });
        }
        case "DELETE": {
          const { ids } = req.postDataJSON() as { ids: string[] };
          const ops: ApiChangeOp[] = [];
          for (const id of ids ?? []) {
            store.delete(id);
            ops.push({ op: "delete", key: id });
          }
          if (ops.length) broadcast(ops);
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
  for (const [collection, rows] of Object.entries(opts.kv ?? {})) {
    const m = new Map<string, unknown>();
    for (const r of rows) m.set(r.key, r.value);
    kv.set(collection, m);
  }
  const ns = (collection: string) => {
    let m = kv.get(collection);
    if (!m) kv.set(collection, (m = new Map()));
    return m;
  };

  await page.route(
    (url) => url.pathname === "/api/kv",
    async (route) => {
      const req = route.request();
      const collection =
        new URL(req.url()).searchParams.get("collection") ?? "";
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

  // The live client loads the outline over a WebSocket (/api/sync), not a GET.
  // Hold the socket so writes can echo their change frames back here; reply to
  // `hello` with a full snapshot at the current seq (a reconnect resumes from
  // committed state, exactly like the DO's snapshot path).
  await page.routeWebSocket(
    (url) => url.pathname === "/api/sync",
    (ws) => {
      socket = ws;
      ws.onMessage(() =>
        ws.send(
          JSON.stringify({
            type: "snapshot",
            seq,
            nodes: [...store.values()],
            ...(opts.serverVersion === undefined
              ? {}
              : { serverVersion: opts.serverVersion }),
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
  {
    id: "alpha-2",
    parentId: "alpha",
    prevSiblingId: "alpha-1",
    text: "Alpha two",
  },
];
