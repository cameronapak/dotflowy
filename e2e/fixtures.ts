import type { Page, Route, WebSocketRoute } from "@playwright/test";

import {
  applyPlan,
  buildTreeIndex,
  planAppendChild,
  planImportNodes,
  planIndent,
  planIndentMany,
  planInsertChildAtStart,
  planInsertSibling,
  planMaterializeDailyNodes,
  planMirrorNode,
  planMoveMany,
  planMoveNode,
  planOutdent,
  planOutdentMany,
  planRemoveMany,
  planRemoveNode,
  planRestoreNodes,
  planSetBookmarkedAt,
  planSetCollapsed,
  planSetCompleted,
  planSetIsTask,
  planSetKind,
  planSetText,
  planSplitNode,
  type OutlineNode,
  type OutlinePlan,
} from "../src/data/outline-plans";
import { resolveDailyClaim } from "../src/plugins/daily/claim-mapping";

/** True when this Playwright process targets the Lunora mock (`E2E_LUNORA=1`
 *  or `seedOutline(..., { lunora: true })`). Specs that override classic
 *  `/api/kv?op=claim` should skip under Lunora — shapes/mutators replace that
 *  transport. */
export function isE2eLunora(opts?: { lunora?: boolean }): boolean {
  if (opts?.lunora === true) return true;
  if (opts?.lunora === false) return false;
  const env = process.env.E2E_LUNORA;
  return env === "1" || env === "true";
}

/** Opt classic specs onto the Lunora mock: `seedOutline(..., { lunora: true })`
 *  or `E2E_LUNORA=1 bunx playwright test …`. Default stays classic (`/api/sync`). */
function wantsLunoraSeed(opts: { lunora?: boolean } | undefined): boolean {
  return isE2eLunora(opts);
}

/** Lunora shape pokes can land after `goto`; wait for a seeded row. No-op classic. */
export async function waitForSeededNode(
  page: Page,
  nodeId: string,
): Promise<void> {
  if (!isE2eLunora()) return;
  await page
    .locator(`li[data-node-id="${nodeId}"]`)
    .waitFor({ state: "attached", timeout: 15_000 });
}

/** `page.goto` + Lunora hydration wait on a known seeded id. */
export async function openSeededOutline(
  page: Page,
  opts: { path?: string; anchorId?: string } = {},
): Promise<void> {
  await page.goto(opts.path ?? "/");
  await waitForSeededNode(page, opts.anchorId ?? "alpha");
}

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
 *
 * Dual-path: pass `{ lunora: true }` or set `E2E_LUNORA=1` to route through
 * `seedOutlineLunora` (flag ON + `/_lunora/*` mock). The classic path sets
 * `dotflowy:flag:lunora-sync=off` so specs stay on `/api/sync` even though
 * the product default is ON. Classic-only opts (`echoDelayMs`, `echoChunks`,
 * `postDelayMs`, `failStructuralWrites`, `serverVersion`) are ignored on the
 * Lunora path — those specs stay classic-only.
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
    /** Force every structural-batch POST (`body.ops`) to fail with a 500 before
     *  it mutates the store, so a spec can drive the save-failure rollback +
     *  toast path (#230). Reads and the legacy seed POST are untouched, so the
     *  seeded outline still loads normally. A received 500 resolves the fetch
     *  (not a transport error), so the client's retry policy doesn't kick in —
     *  the failure lands immediately. */
    failStructuralWrites?: boolean;
    /** When true, use the Lunora `/_lunora/*` mock + enable the client flag.
     *  Also enabled by `E2E_LUNORA=1` / `true` when this is unset. */
    lunora?: boolean;
  } = {},
): Promise<void> {
  if (wantsLunoraSeed(opts)) {
    return seedOutlineLunora(page, nodes, { kv: opts.kv });
  }

  // Product default is Lunora ON; classic e2e mocks `/api/sync` only.
  await page.addInitScript(() => {
    window.localStorage.setItem("dotflowy:flag:lunora-sync", "off");
  });

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
            // Injected failure (#230): reject the batch BEFORE touching the
            // store, so the optimistic overlay rolls back and the save-failure
            // toast fires.
            if (opts.failStructuralWrites) {
              return route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ error: "boom" }),
              });
            }
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

// --- Lunora flag-ON fixture (ADR 0055) --------------------------------------

type LunoraRow = ApiNode & { userId: string; _id: string };

function toLunoraRow(n: SeedNode, userId: string): LunoraRow {
  const base = toNode(n);
  return { ...base, _id: base.id, userId };
}

function rowToOutline(row: LunoraRow): OutlineNode {
  const { _id: _, ...rest } = row;
  return rest;
}

function outlineToRow(node: OutlineNode): LunoraRow {
  return { ...node, _id: node.id };
}

function commitOutlinePlan(
  store: Map<string, LunoraRow>,
  plan: OutlinePlan | null | undefined,
): void {
  if (!plan) return;
  const next = applyPlan([...store.values()].map(rowToOutline), plan);
  store.clear();
  for (const n of next) store.set(n.id, outlineToRow(n));
}

type DailyIndexRow = {
  _id: string;
  key: string;
  nodeId: string;
  touchedAt: number;
  userId: string;
};

type TagColorRow = {
  _id: string;
  tag: string;
  color: string;
  userId: string;
};

type SavedQueryRow = {
  _id: string;
  name: string;
  query: string;
  createdAt: number;
  userId: string;
};

/**
 * Seed an outline on the Lunora flag-ON path by mocking `/_lunora/ws` +
 * `/_lunora/rpc`. Structural mutators apply the same `outline-plans` pure
 * planners as production (insert/split/indent/delete/restore/move/multi/…).
 *
 * Also reachable via `seedOutline(..., { lunora: true })` or `E2E_LUNORA=1`
 * so classic specs can run against Lunora without rewriting call sites.
 * Auto-migrate is skipped by mocking GET `/api/nodes` → [].
 */
export async function seedOutlineLunora(
  page: Page,
  nodes: SeedNode[],
  opts: {
    userId?: string;
    /** Pre-seed Lunora kv shapes from classic kv collection names
     *  (`daily-index` / `tag-colors` / `saved-queries`). */
    kv?: Record<string, { key: string; value: unknown }[]>;
  } = {},
): Promise<void> {
  // Drop prior Lunora mocks from earlier tests on this page — stacked
  // `routeWebSocket` handlers can keep an old in-memory store alive across
  // reload (delete "persists" then resurrects from the stale mock).
  await page.unroute("**/_lunora/**");
  await page.unroute("**/api/auth/get-session");
  await page.unroute("**/api/nodes");
  await page.unroute("**/api/kv");

  const userId = opts.userId ?? "test-user";
  const store = new Map<string, LunoraRow>();
  for (const n of nodes) store.set(n.id, toLunoraRow(n, userId));

  const dailyIndex = new Map<string, DailyIndexRow>();
  for (const r of opts.kv?.["daily-index"] ?? []) {
    const v = r.value as { key?: string; nodeId?: string };
    const key = v.key ?? r.key;
    const nodeId = String(v.nodeId ?? "");
    dailyIndex.set(key, {
      _id: key,
      key,
      nodeId,
      touchedAt: 0,
      userId,
    });
  }

  const tagColors = new Map<string, TagColorRow>();
  for (const r of opts.kv?.["tag-colors"] ?? []) {
    const v = r.value as { tag?: string; color?: string };
    const tag = String(v.tag ?? r.key);
    tagColors.set(tag, {
      _id: tag,
      tag,
      color: String(v.color ?? ""),
      userId,
    });
  }

  const savedQueries = new Map<string, SavedQueryRow>();
  for (const r of opts.kv?.["saved-queries"] ?? []) {
    const v = r.value as {
      id?: string;
      name?: string;
      query?: string;
      createdAt?: number;
    };
    const id = String(v.id ?? r.key);
    savedQueries.set(id, {
      _id: id,
      name: String(v.name ?? ""),
      query: String(v.query ?? ""),
      createdAt: Number(v.createdAt ?? 0),
      userId,
    });
  }

  let clientSeq = 0;
  let pokeN = 0;
  /** Per-shape poke cursor — a shared counter desyncs shapes and Lunora
   *  drops the poke (`baseDiverged`) without firing `onCheckpoint`, which
   *  wedges `isPersisted` (claimDaily / materializeDaily / seedIfEmpty). */
  const shapeCheckpoints = new Map<string, number>();
  /** Last keys we put into each shape — poke is a diff; without deletes for
   *  removed keys the client view keeps stale rows (Cmd+K delete "works" then
   *  the poke resurrects the bullet). */
  const shapeKeys = new Map<string, Set<string>>();
  const sockets = new Set<WebSocketRoute>();
  const shapeSubs = new Map<string, { name: string }>();

  const reply = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });

  const sendPoke = (
    ws: WebSocketRoute,
    shapeId: string,
    rows: Array<Record<string, unknown> & { _id: string }>,
    lastMutationId: number,
  ) => {
    pokeN += 1;
    const pokeId = `p${pokeN}`;
    const base = shapeCheckpoints.get(shapeId) ?? 0;
    const next = base + 1;
    shapeCheckpoints.set(shapeId, next);
    const nextKeys = new Set(rows.map((r) => r._id));
    const prevKeys = shapeKeys.get(shapeId) ?? new Set<string>();
    const rowsPatch: Array<Record<string, unknown>> = [];
    for (const key of prevKeys) {
      if (!nextKeys.has(key)) rowsPatch.push({ op: "delete", key });
    }
    for (const r of rows) {
      rowsPatch.push({ op: "put", key: r._id, value: r });
    }
    shapeKeys.set(shapeId, nextKeys);
    ws.send(
      JSON.stringify({
        type: "pokeStart",
        pokeId,
        baseCheckpoint: base,
        epoch: 1,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "pokePart",
        pokeId,
        shapeId,
        lastMutationId,
        rowsPatch,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "pokeEnd",
        pokeId,
        checkpoint: next,
        epoch: 1,
      }),
    );
  };

  const shapeRows = (
    name: string,
  ): Array<Record<string, unknown> & { _id: string }> => {
    if (name === "wholeOutline") return [...store.values()];
    if (name === "userDailyIndex") return [...dailyIndex.values()];
    if (name === "userTagColors") return [...tagColors.values()];
    if (name === "userSavedQueries") return [...savedQueries.values()];
    return [];
  };

  const seedShape = (ws: WebSocketRoute, shapeId: string, name: string) => {
    sendPoke(ws, shapeId, shapeRows(name), 0);
  };

  const pokeSubscribed = (seq: number, shapes: ReadonlySet<string>) => {
    for (const ws of sockets) {
      for (const [shapeId, meta] of shapeSubs) {
        if (!shapes.has(meta.name)) continue;
        sendPoke(ws, shapeId, shapeRows(meta.name), seq);
      }
    }
  };

  const liveIndex = () => buildTreeIndex([...store.values()].map(rowToOutline));
  const liveNodes = () => [...store.values()].map(rowToOutline);

  await page.addInitScript(() => {
    window.localStorage.setItem("dotflowy:flag:lunora-sync", "on");
  });

  await page.route(
    (url) => url.pathname === "/api/auth/get-session",
    (route) =>
      reply(route, {
        session: {
          id: "test-session",
          userId,
          token: "test-token",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        user: {
          id: userId,
          email: "test@example.com",
          name: "Test User",
          emailVerified: true,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
  );

  // Empty classic DO so auto-migrate no-ops (Lunora store is the seed).
  await page.route(
    (url) => url.pathname === "/api/nodes",
    (route) => {
      if (route.request().method() === "GET") return reply(route, []);
      return route.fulfill({ status: 404, body: "{}" });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/kv",
    (route) => {
      if (route.request().method() === "GET") return reply(route, []);
      return route.fulfill({ status: 404, body: "{}" });
    },
  );

  await page.route(
    (url) => url.pathname === "/_lunora/rpc",
    async (route) => {
      const body = route.request().postDataJSON() as {
        functionPath?: string;
        args?: Record<string, unknown>;
      };
      const path = body.functionPath ?? "";
      const args = (body.args ?? {}) as Record<string, unknown>;
      const seqHeader = route.request().headers()["x-lunora-client-seq"];
      const seq = seqHeader ? Number(seqHeader) : ++clientSeq;
      if (Number.isFinite(seq)) clientSeq = Math.max(clientSeq, seq);

      let result: unknown = {};
      let pokeShapes = new Set<string>(["wholeOutline"]);

      const id = () => String(args.id ?? "");
      const updatedAt = () => Number(args.updatedAt ?? Date.now());

      if (path === "mutators:setText") {
        commitOutlinePlan(
          store,
          planSetText(liveIndex(), id(), String(args.text ?? ""), updatedAt()),
        );
        result = { id: id() };
      } else if (path === "mutators:setCompleted") {
        commitOutlinePlan(
          store,
          planSetCompleted(
            liveIndex(),
            id(),
            Boolean(args.completed),
            updatedAt(),
          ),
        );
      } else if (path === "mutators:setCollapsed") {
        commitOutlinePlan(
          store,
          planSetCollapsed(
            liveIndex(),
            id(),
            Boolean(args.collapsed),
            updatedAt(),
          ),
        );
      } else if (path === "mutators:setIsTask") {
        commitOutlinePlan(
          store,
          planSetIsTask(liveIndex(), id(), Boolean(args.isTask), updatedAt()),
        );
      } else if (path === "mutators:setKind") {
        commitOutlinePlan(
          store,
          planSetKind(
            liveIndex(),
            id(),
            args.kind === "paragraph" ? "paragraph" : null,
            updatedAt(),
          ),
        );
      } else if (path === "mutators:setBookmarkedAt") {
        commitOutlinePlan(
          store,
          planSetBookmarkedAt(
            liveIndex(),
            id(),
            (args.bookmarkedAt as number | null) ?? null,
            updatedAt(),
          ),
        );
      } else if (path === "mutators:insertSibling") {
        commitOutlinePlan(
          store,
          planInsertSibling(liveIndex(), {
            id: id(),
            userId,
            parentId: (args.parentId as string | null) ?? null,
            afterId: (args.afterId as string | null) ?? null,
            text: String(args.text ?? ""),
            isTask: Boolean(args.isTask),
            kind: args.kind === "paragraph" ? "paragraph" : null,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { id: id() };
      } else if (path === "mutators:insertChildAtStart") {
        commitOutlinePlan(
          store,
          planInsertChildAtStart(liveIndex(), {
            id: id(),
            userId,
            parentId: (args.parentId as string | null) ?? null,
            text: String(args.text ?? ""),
            isTask: Boolean(args.isTask),
            kind: args.kind === "paragraph" ? "paragraph" : null,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { id: id() };
      } else if (path === "mutators:appendChild") {
        commitOutlinePlan(
          store,
          planAppendChild(liveIndex(), {
            id: id(),
            userId,
            parentId: (args.parentId as string | null) ?? null,
            text: String(args.text ?? ""),
            isTask: Boolean(args.isTask),
            kind: args.kind === "paragraph" ? "paragraph" : null,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { id: id() };
      } else if (path === "mutators:splitNode") {
        const newId = String(args.newId ?? "");
        commitOutlinePlan(
          store,
          planSplitNode(liveIndex(), {
            id: id(),
            newId,
            userId,
            parentId: (args.parentId as string | null) ?? null,
            afterId: String(args.afterId ?? id()),
            leftText: String(args.leftText ?? ""),
            rightText: String(args.rightText ?? ""),
            isTask: Boolean(args.isTask),
            kind: args.kind === "paragraph" ? "paragraph" : null,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { id: newId };
      } else if (path === "mutators:indent") {
        commitOutlinePlan(
          store,
          planIndent(
            liveIndex(),
            id(),
            updatedAt(),
            Boolean(args.resolveMirror),
          ),
        );
      } else if (path === "mutators:outdent") {
        commitOutlinePlan(store, planOutdent(liveIndex(), id(), updatedAt()));
      } else if (path === "mutators:removeNode") {
        commitOutlinePlan(
          store,
          planRemoveNode(liveIndex(), id(), updatedAt()),
        );
      } else if (path === "mutators:moveNode") {
        commitOutlinePlan(
          store,
          planMoveNode(liveIndex(), {
            id: id(),
            newParentId: (args.newParentId as string | null) ?? null,
            afterSiblingId: (args.afterSiblingId as string | null) ?? null,
            updatedAt: updatedAt(),
            expandIds: args.expandIds as string[] | undefined,
          }),
        );
      } else if (path === "mutators:restoreNodes") {
        const target = (args.nodes as OutlineNode[] | undefined) ?? [];
        commitOutlinePlan(store, planRestoreNodes(liveNodes(), target));
        result = { ok: true };
      } else if (path === "mutators:importNodes") {
        const imported = (args.nodes as OutlineNode[] | undefined) ?? [];
        commitOutlinePlan(store, planImportNodes(imported));
        result = { count: imported.length };
      } else if (path === "mutators:mirrorNode") {
        commitOutlinePlan(
          store,
          planMirrorNode(liveIndex(), {
            id: id(),
            userId,
            sourceId: String(args.sourceId ?? ""),
            targetParentId: (args.targetParentId as string | null) ?? null,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { id: id() };
      } else if (path === "mutators:removeMany") {
        const nodeIds = (args.nodeIds as string[] | undefined) ?? [];
        commitOutlinePlan(
          store,
          planRemoveMany(liveNodes(), nodeIds, updatedAt()),
        );
      } else if (path === "mutators:moveMany") {
        const nodeIds = (args.nodeIds as string[] | undefined) ?? [];
        commitOutlinePlan(
          store,
          planMoveMany(liveNodes(), {
            targetId: (args.targetId as string | null) ?? null,
            nodeIds,
            updatedAt: updatedAt(),
          }),
        );
      } else if (path === "mutators:indentMany") {
        const nodeIds = (args.nodeIds as string[] | undefined) ?? [];
        commitOutlinePlan(
          store,
          planIndentMany(
            liveNodes(),
            nodeIds,
            updatedAt(),
            Boolean(args.resolveMirror),
          ),
        );
      } else if (path === "mutators:outdentMany") {
        const nodeIds = (args.nodeIds as string[] | undefined) ?? [];
        commitOutlinePlan(
          store,
          planOutdentMany(liveNodes(), nodeIds, updatedAt()),
        );
      } else if (path === "mutators:materializeDailyNodes") {
        const inserts =
          (args.inserts as
            | {
                id: string;
                parentId: string | null;
                afterId: string | null;
                text: string;
              }[]
            | undefined) ?? [];
        commitOutlinePlan(
          store,
          planMaterializeDailyNodes(liveNodes(), {
            userId,
            inserts,
            createdAt: Number(args.createdAt ?? 0),
            updatedAt: updatedAt(),
          }),
        );
        result = { count: inserts.length };
      } else if (path === "mutators:seedIfEmpty") {
        result = { seeded: false };
      } else if (path === "mutators:upsertTagColor") {
        const tag = String(args.tag ?? "");
        tagColors.set(tag, {
          _id: tag,
          tag,
          color: String(args.color ?? ""),
          userId,
        });
        pokeShapes = new Set(["userTagColors"]);
      } else if (path === "mutators:deleteTagColor") {
        tagColors.delete(String(args.tag ?? ""));
        pokeShapes = new Set(["userTagColors"]);
      } else if (path === "mutators:upsertSavedQuery") {
        const sid = String(args.id ?? "");
        savedQueries.set(sid, {
          _id: sid,
          name: String(args.name ?? ""),
          query: String(args.query ?? ""),
          createdAt: Number(args.createdAt ?? 0),
          userId,
        });
        pokeShapes = new Set(["userSavedQueries"]);
      } else if (path === "mutators:patchSavedQuery") {
        const sid = String(args.id ?? "");
        const cur = savedQueries.get(sid);
        if (cur) {
          savedQueries.set(sid, {
            ...cur,
            name: args.name !== undefined ? String(args.name) : cur.name,
            query: args.query !== undefined ? String(args.query) : cur.query,
          });
        }
        pokeShapes = new Set(["userSavedQueries"]);
      } else if (path === "mutators:deleteSavedQuery") {
        savedQueries.delete(String(args.id ?? ""));
        pokeShapes = new Set(["userSavedQueries"]);
      } else if (path === "mutators:claimDailyMapping") {
        const key = String(args.key ?? "");
        const candidate = String(args.nodeId ?? "");
        const existing = dailyIndex.get(key);
        const { winner, won } = resolveDailyClaim(existing?.nodeId, candidate);
        dailyIndex.set(key, {
          _id: key,
          key,
          nodeId: winner,
          touchedAt: Number(args.touchedAt ?? Date.now()),
          userId,
        });
        result = { nodeId: winner, won };
        pokeShapes = new Set(["userDailyIndex"]);
      } else if (path === "mutators:upsertDailyMapping") {
        const key = String(args.key ?? "");
        dailyIndex.set(key, {
          _id: key,
          key,
          nodeId: String(args.nodeId ?? ""),
          touchedAt: Number(args.touchedAt ?? Date.now()),
          userId,
        });
        pokeShapes = new Set(["userDailyIndex"]);
      } else if (path === "mutators:deleteDailyMapping") {
        dailyIndex.delete(String(args.key ?? ""));
        pokeShapes = new Set(["userDailyIndex"]);
      }
      // Unknown mutators: accept so watermark chain doesn't wedge.

      // Watermark is per-client on the shard (wholeOutline checkpoints gate
      // isPersisted). Kv-only mutators must still advance wholeOutline or
      // claimDailyMapping / materializeDailyNodes hang awaiting the poke.
      pokeShapes.add("wholeOutline");

      await reply(route, { result, lastMutationId: seq });
      pokeSubscribed(seq, pokeShapes);
    },
  );

  await page.routeWebSocket(
    (url) => url.pathname === "/_lunora/ws",
    (ws) => {
      sockets.add(ws);
      ws.onClose(() => sockets.delete(ws));
      ws.onMessage((raw) => {
        if (typeof raw !== "string") return;
        if (raw === "lunora-ping") {
          ws.send("lunora-pong");
          return;
        }
        let msg: {
          type?: string;
          id?: string;
          shape?: { name?: string; args?: unknown };
        };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "connect") {
          return;
        }
        if (msg.type === "shape_subscribe" && msg.id && msg.shape?.name) {
          shapeSubs.set(msg.id, { name: msg.shape.name });
          seedShape(ws, msg.id, msg.shape.name);
        }
      });
    },
  );
}
