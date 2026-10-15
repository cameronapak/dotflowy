import { Schema } from "effect";

import type { ChangeOp, ServerMessage } from "../data/realtime";
import type { Node } from "../data/schema";

import {
  KvClaimBody,
  KvDeleteBody,
  KvUpsertBody,
  NodesDeleteBody,
  NodesPatchBody,
  NodesPostBody,
  WeekStartPostBody,
} from "../../worker/wire";
import {
  embedResource,
  spotifyFallbackDescriptor,
  type EmbedDescriptor,
} from "../data/embed-providers";
import { hasWindow } from "../env";
import { demoSeed } from "./outline";

/**
 * The demo backend: an in-memory stand-in for the Worker and the per-user
 * Durable Object, installed in the browser so the real app runs with no
 * account and no network. It speaks the same `/api` contract the e2e mock
 * does (e2e/fixtures.ts): `/api/sync` streams a snapshot and echoes every
 * write as a change frame, `/api/nodes` applies writes, `/api/kv` holds the
 * plugin side-collections. Everything above the wire — the collection, the
 * structural writes, the editor, the plugins — is the production code path.
 *
 * Containment is the point. Once installed, EVERY same-origin `/api` request
 * is answered here and never reaches the Worker, so a signed-in visitor who
 * opens the demo cannot touch their real outline, and the demo session is a
 * client-side fiction the server never sees. A reload starts over.
 */

/** The `name` the landing page gives its demo iframe. It survives a reload
 *  inside the frame, which the `/demo` path does not (zooming changes it). */
export const DEMO_FRAME_NAME = "dotflowy-demo";

/** Demo mode is chosen once, at boot: a `/demo` URL, or a reload inside the
 *  landing page's named iframe. A top-level tab never inherits it by name. */
export function isDemoBoot(): boolean {
  if (!hasWindow()) return false;
  if (/^\/demo\/?$/.test(window.location.pathname)) return true;
  return window.top !== window && window.name === DEMO_FRAME_NAME;
}

const DEMO_USER = {
  id: "demo",
  email: "demo@dotflowy.com",
  name: "Demo",
  emailVerified: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const json = <T>(data: T, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function bodyOf<A, I>(
  schema: Schema.Codec<A, I>,
  request: Request,
): Promise<A> {
  return Schema.decodeUnknownSync(schema)(await request.json());
}

/**
 * The Worker looks embeds up through each provider's oEmbed endpoint. The
 * demo can't, so it builds the player URL that lookup would return for the
 * providers whose players are addressable by id. Any supported link a visitor
 * pastes embeds the same way. X renders through its own widget in the browser
 * and never asks the server.
 */
function demoEmbed(text: string): EmbedDescriptor | null {
  const resource = embedResource(text);
  switch (resource?.provider) {
    case "youtube":
      return {
        provider: "youtube",
        src: `https://www.youtube.com/embed/${resource.id}`,
        width: 560,
        height: 315,
        title: "YouTube video",
      };
    case "vimeo":
      return {
        provider: "vimeo",
        src: `https://player.vimeo.com/video/${resource.id}`,
        width: 640,
        height: 360,
        title: "Vimeo video",
      };
    default:
      return spotifyFallbackDescriptor(resource ?? null);
  }
}

export function installDemoBackend(): void {
  const store = new Map<string, Node>();
  const seed = demoSeed();
  for (const n of seed.nodes) store.set(n.id, n);
  const kv = new Map<string, Map<string, unknown>>();
  for (const [collection, rows] of Object.entries(seed.kv))
    kv.set(collection, new Map(rows.map((r) => [r.key, r.value])));
  const ns = (collection: string) => {
    let m = kv.get(collection);
    if (!m) kv.set(collection, (m = new Map()));
    return m;
  };

  let seq = 0;
  const sockets = new Set<DemoSocket>();
  const broadcast = (ops: readonly ChangeOp[], clientId?: string): number => {
    seq += 1;
    const frame: ServerMessage = { type: "change", seq, ops, clientId };
    for (const s of sockets) s.deliver(frame);
    return seq;
  };
  const apply = (ops: readonly ChangeOp[]) => {
    for (const op of ops) {
      if (op.op === "delete") store.delete(op.key);
      else store.set(op.value.id, op.value);
    }
  };

  async function nodes(request: Request): Promise<Response> {
    switch (request.method) {
      case "GET":
        return json([...store.values()]);
      case "POST": {
        const body = await bodyOf(NodesPostBody, request);
        if (body.ops) {
          if (body.expectedSeq !== undefined && body.expectedSeq !== seq)
            return json({ error: "stale_outline" }, 409);
          apply(body.ops);
          return json({ seq: broadcast(body.ops, body.clientId) });
        }
        const ops: ChangeOp[] = (body.nodes ?? []).map((value) => ({
          op: "insert",
          value,
        }));
        apply(ops);
        if (ops.length) broadcast(ops, body.clientId);
        return json({ ok: true });
      }
      case "PATCH": {
        const { updates, clientId } = await bodyOf(NodesPatchBody, request);
        const ops: ChangeOp[] = [];
        for (const u of updates) {
          const cur = store.get(u.id);
          if (!cur) continue;
          // SAFETY: the client only patches Node fields (collection.ts onUpdate).
          const value = { ...cur, ...(u.changes as Partial<Node>) };
          store.set(u.id, value);
          ops.push({ op: "update", value });
        }
        if (ops.length) broadcast(ops, clientId);
        return json({ ok: true, seq });
      }
      case "DELETE": {
        const { ids, clientId } = await bodyOf(NodesDeleteBody, request);
        const ops: ChangeOp[] = ids.map((key) => ({ op: "delete", key }));
        apply(ops);
        if (ops.length) broadcast(ops, clientId);
        return json({ ok: true });
      }
      default:
        return json({}, 405);
    }
  }

  async function kvRoute(request: Request, url: URL): Promise<Response> {
    const m = ns(url.searchParams.get("collection") ?? "");
    switch (request.method) {
      case "GET":
        return json([...m.values()]);
      case "POST": {
        if (url.searchParams.get("op") === "claim") {
          const { key, value } = await bodyOf(KvClaimBody, request);
          if (!m.has(key)) m.set(key, value);
          return json({ value: m.get(key) });
        }
        const { rows } = await bodyOf(KvUpsertBody, request);
        for (const r of rows) m.set(r.key, r.value);
        return json({ ok: true });
      }
      case "DELETE": {
        const { keys } = await bodyOf(KvDeleteBody, request);
        for (const k of keys) m.delete(k);
        return json({ ok: true });
      }
      default:
        return json({}, 405);
    }
  }

  async function weekStart(request: Request): Promise<Response> {
    const body = await bodyOf(WeekStartPostBody, request);
    const prefs = ns("account-prefs");
    // SAFETY: only this route writes this key, always in this shape.
    const current = prefs.get("daily:week-start") as
      | { weekStart?: "sunday" | "monday" }
      | undefined;
    const value =
      body.operation === "set"
        ? body.weekStart
        : (current?.weekStart ?? "monday");
    prefs.set("daily:week-start", {
      key: "daily:week-start",
      weekStart: value,
    });
    return json({ weekStart: value, seq });
  }

  async function handle(request: Request, url: URL): Promise<Response> {
    switch (url.pathname) {
      case "/api/auth/get-session":
        return json({
          session: {
            id: "demo-session",
            userId: DEMO_USER.id,
            token: "demo",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          user: DEMO_USER,
        });
      case "/api/nodes":
        return nodes(request);
      case "/api/kv":
        return kvRoute(request, url);
      case "/api/daily/week-start":
        return weekStart(request);
      case "/api/embeds":
        return json({ embed: demoEmbed(url.searchParams.get("url") ?? "") });
      default:
        // Anything else (link titles, billing, settings) has no demo
        // answer. A 404 keeps it local; the feature degrades as offline.
        return json({ error: "not_in_demo" }, 404);
    }
  }

  const realFetch = window.fetch.bind(window);
  const demoFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/api")
    )
      return realFetch(request);
    // Let the current task finish first, as a network round trip would.
    await Promise.resolve();
    return handle(request, url);
  };

  /** A WebSocket that never leaves the page. Only `/api/sync` is faked; any
   *  other socket would be a new server dependency, so it is refused. */
  class DemoSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = "arraybuffer";
    readonly url: string;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      if (new URL(this.url).pathname !== "/api/sync")
        throw new Error(`Demo mode has no socket at ${this.url}`);
      sockets.add(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    /** The only client frame is `hello`; answer it with the current outline. */
    send(_data: string): void {
      this.deliver({ type: "snapshot", seq, nodes: [...store.values()] });
    }

    deliver(frame: ServerMessage): void {
      const data = JSON.stringify(frame);
      setTimeout(() => {
        if (this.readyState === 1)
          this.dispatchEvent(new MessageEvent("message", { data }));
      });
    }

    close(code = 1000): void {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      sockets.delete(this);
      this.dispatchEvent(new CloseEvent("close", { code }));
    }
  }
  // Swap the globals the app's transports call at request time. DemoSocket
  // implements the slice of WebSocket Effect's socket uses (readyState, send,
  // close, and the open/message/close events).
  Object.defineProperty(window, "fetch", { value: demoFetch, writable: true });
  Object.defineProperty(window, "WebSocket", {
    value: DemoSocket,
    writable: true,
  });
}
