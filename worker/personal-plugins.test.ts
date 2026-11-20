/**
 * Personal plugins (ADR 0095) against in-memory fakes of the two stores: the
 * DO kv table (with the same compare-and-set rule as UserOutlineDO) and the
 * Artifacts repos (one history per repo; a stale base is refused, as a
 * rejected git push is). Covers the gates, versions, name ownership, and the
 * lifecycle a user relies on.
 */

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import type { OutlineStore } from "./mcp-tools";
import type { PluginSource } from "./personal-plugin-source";

import { handleMcp } from "./mcp";
import {
  activateVersion,
  deleteAllPluginRepos,
  deleteHistory,
  handlePersonalPluginsRequest,
  type PluginContext,
  type PluginKv,
  personalPluginsEligible,
  personalPluginTools,
  savePlugin,
  setEnabled,
  uninstall,
} from "./personal-plugins";

type Row = { key: string; value: unknown };
type Body = {
  id?: string;
  enabled?: boolean;
  pluginId?: string;
  key?: string;
  text?: string;
};

function fakeKv(beforeCas?: (rows: Map<string, string>) => void) {
  const rows = new Map<string, string>();
  const kv: PluginKv = {
    getKv: () => [...rows.values()].map((v) => JSON.parse(v)),
    upsertKv: (_c, upserts: readonly Row[]) => {
      for (const r of upserts) rows.set(r.key, JSON.stringify(r.value));
    },
    compareAndSetKv: (_c, expected, upserts, deletes) => {
      beforeCas?.(rows);
      for (const e of expected)
        if (
          (rows.get(e.key) ?? null) !==
          (e.value === null ? null : JSON.stringify(e.value))
        )
          return false;
      for (const r of upserts) rows.set(r.key, JSON.stringify(r.value));
      for (const k of deletes) rows.delete(k);
      return true;
    },
  };
  return { kv, rows };
}

function fakeSource() {
  const repos = new Map<
    string,
    { version: string; note: string; content: string }[]
  >();
  let count = 0;
  const source: PluginSource = {
    async commit(repo, content, note, base) {
      const history = repos.get(repo) ?? [];
      const head = history.at(-1)?.version ?? null;
      if (base !== undefined && base !== head)
        return { ok: false, conflict: true, head };
      const version = `c${++count}`;
      repos.set(repo, [...history, { version, note, content }]);
      return { ok: true, version };
    },
    async history(repo) {
      return [...(repos.get(repo) ?? [])]
        .reverse()
        .map((c) => ({ version: c.version, note: c.note, createdAt: "" }));
    },
    async read(repo, version) {
      return (
        repos.get(repo)?.find((c) => c.version === version)?.content ?? null
      );
    },
    async remove(repo) {
      repos.delete(repo);
    },
  };
  return { source, repos };
}

function setup(beforeCas?: (rows: Map<string, string>) => void) {
  const { kv, rows } = fakeKv(beforeCas);
  const { source, repos } = fakeSource();
  const ctx: PluginContext = { kv, source, doName: "user1" };
  return { ctx, rows, repos };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return JSON.stringify(exit.cause);
};

const chips = (id: string, name: string, extra = {}) => ({
  id,
  name: id,
  components: [{ name, kind: "inline", view: "chip" }],
  ...extra,
});

const api = (ctx: PluginContext, method: string, path: string, body?: Body) =>
  Effect.runPromise(
    handlePersonalPluginsRequest(
      new Request(`https://app.test/api/personal-plugins/${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
      ctx,
    ),
  );

test("eligibility needs the exact flag, the binding, a paid plan, and the beta list", () => {
  // SAFETY: eligibility only checks that the binding is present.
  const ARTIFACTS = {} as Artifacts;
  expect(personalPluginsEligible({ ARTIFACTS }, "u1", "unlimited")).toBe(false);
  expect(
    personalPluginsEligible(
      { PERSONAL_PLUGINS: "TRUE", ARTIFACTS },
      "u1",
      "unlimited",
    ),
  ).toBe(false);
  expect(
    personalPluginsEligible({ PERSONAL_PLUGINS: "true" }, "u1", "unlimited"),
  ).toBe(false);
  expect(
    personalPluginsEligible(
      { PERSONAL_PLUGINS: "true", ARTIFACTS },
      "u1",
      "free",
    ),
  ).toBe(false);
  expect(
    personalPluginsEligible(
      { PERSONAL_PLUGINS: "true", ARTIFACTS },
      "u1",
      "unlimited",
    ),
  ).toBe(true);
  const beta = {
    PERSONAL_PLUGINS: "true",
    PERSONAL_PLUGINS_USERS: "owner, u2",
    ARTIFACTS,
  };
  expect(personalPluginsEligible(beta, "u1", "unlimited")).toBe(false);
  expect(personalPluginsEligible(beta, "u2", "unlimited")).toBe(true);
});

test("MCP offers only the guide before opt-in; read keys never see write tools", async () => {
  const { ctx } = setup();
  // SAFETY: these calls never reach the outline store.
  const store = {} as OutlineStore;
  const list = async (optedIn: boolean, permission: "read" | "write") => {
    const res = await Effect.runPromise(
      handleMcp(
        new Request("https://app.test/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
        store,
        true,
        undefined,
        permission,
        personalPluginTools(ctx, optedIn),
      ),
    );
    // SAFETY: tools/list answers with this shape.
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    return body.result.tools
      .map((t) => t.name)
      .filter((n) => n.includes("personal_plugin"));
  };
  expect(await list(false, "write")).toEqual(["get_personal_plugin_guide"]);
  expect(await list(true, "write")).toEqual([
    "get_personal_plugin_guide",
    "list_personal_plugins",
    "get_personal_plugin",
    "save_personal_plugin",
    "activate_personal_plugin_version",
    "remove_personal_plugin",
    "delete_personal_plugin_history",
  ]);
  expect(await list(true, "read")).toEqual([
    "get_personal_plugin_guide",
    "list_personal_plugins",
    "get_personal_plugin",
  ]);
});

test("only declarative definitions save; commands alone are a plugin", async () => {
  const { ctx, repos } = setup();
  for (const [definition, reason] of [
    [
      { ...chips("x", "s"), backend: { source: "export default {}" } },
      "excess",
    ],
    [
      {
        id: "x",
        name: "X",
        components: [
          { name: "s", kind: "block", view: "sandbox", html: "<b>" },
        ],
      },
      "excess",
    ],
    [chips("x", "verse"), "reserved"],
    [
      {
        id: "x",
        name: "X",
        components: [{ name: "s", kind: "inline", view: "board" }],
      },
      "chip",
    ],
    [{ id: "x", name: "X" }, "at least one"],
  ] as const)
    expect(await failure(savePlugin(ctx, { definition, note: "n" }))).toContain(
      reason,
    );
  expect(repos.size).toBe(0);
  const saved = await run(
    savePlugin(ctx, {
      definition: {
        id: "cmd",
        name: "Cmd",
        commands: [{ label: "Board", insert: "::board" }],
      },
      note: "commands only",
    }),
  );
  expect(saved.live).toBe(true);
});

test("history keeps every version, and drafts never evict the live one", async () => {
  const { ctx, repos } = setup();
  const live = await run(
    savePlugin(ctx, { definition: chips("p", "status"), note: "v1" }),
  );
  for (let i = 0; i < 25; i++)
    await run(
      savePlugin(ctx, {
        definition: chips("p", "status", { description: `draft ${i}` }),
        note: `draft ${i}`,
        activate: false,
      }),
    );
  expect(repos.get("user1.p")).toHaveLength(26);
  const state = await (await api(ctx, "GET", "state")).json();
  expect(state).toEqual({ optedIn: false, plugins: [] });
  await api(ctx, "PUT", "opt-in", { enabled: true });
  // SAFETY: GET /state answers PersonalPluginsState.
  const after = (await (await api(ctx, "GET", "state")).json()) as {
    plugins: { version: string; definition: { description?: string } }[];
  };
  expect(after.plugins).toHaveLength(1);
  expect(after.plugins[0]?.version).toBe(live.version);
  expect(after.plugins[0]?.definition.description).toBeUndefined();
});

test("a save from a stale version is refused and changes nothing", async () => {
  const { ctx, rows } = setup();
  const v1 = await run(
    savePlugin(ctx, { definition: chips("p", "a"), note: "v1" }),
  );
  await run(savePlugin(ctx, { definition: chips("p", "b"), note: "v2" }));
  const before = new Map(rows);
  const error = await failure(
    savePlugin(ctx, {
      definition: chips("p", "c"),
      note: "v3",
      baseVersion: v1.version,
    }),
  );
  expect(error).toContain("409");
  expect(rows).toEqual(before);
});

test("a racing change makes activation fail cleanly instead of half-applying", async () => {
  let race = false;
  const { ctx, rows } = setup((current) => {
    if (!race) return;
    race = false;
    // Another request switches the plugin off between read and write.
    const row = JSON.parse(current.get("plugin:p")!);
    current.set("plugin:p", JSON.stringify({ ...row, enabled: false }));
  });
  const v1 = await run(
    savePlugin(ctx, { definition: chips("p", "a"), note: "v1" }),
  );
  await run(savePlugin(ctx, { definition: chips("p", "b"), note: "v2" }));
  race = true;
  expect(await failure(activateVersion(ctx, "p", v1.version))).toContain("409");
  // The live version and its name claim are still v2's.
  expect(
    JSON.parse(rows.get("plugin:p")!).active.definition.components[0].name,
  ).toBe("b");
  expect(rows.has("name:a")).toBe(false);
  expect(rows.has("name:b")).toBe(true);
});

test("a component name has one owner, checked again on every activation", async () => {
  const { ctx } = setup();
  await run(savePlugin(ctx, { definition: chips("a", "status"), note: "a" }));
  expect(
    await failure(
      savePlugin(ctx, { definition: chips("b", "status"), note: "b" }),
    ),
  ).toContain("already belongs");
  const draft = await run(
    savePlugin(ctx, {
      definition: chips("b", "status"),
      note: "b",
      activate: false,
    }),
  );
  expect(await failure(activateVersion(ctx, "b", draft.version))).toContain(
    "already belongs",
  );
  await run(uninstall(ctx, "a"));
  expect(await run(activateVersion(ctx, "b", draft.version))).toEqual({
    id: "b",
    activeVersion: draft.version,
  });
});

test("off, removed, and deleted plugins stop serving; only delete drops history", async () => {
  const { ctx, rows, repos } = setup();
  await api(ctx, "PUT", "opt-in", { enabled: true });
  const definition = {
    ...chips("p", "status"),
    panel: { title: "Notes", blocks: [{ type: "notepad", key: "week" }] },
  };
  await run(savePlugin(ctx, { definition, note: "v1" }));
  const write = (text: string) =>
    api(ctx, "PUT", "data", { pluginId: "p", key: "week", text });
  expect((await write("hello")).status).toBe(200);
  expect((await write("hi")).status).toBe(200);
  // A key the definition doesn't declare is refused.
  expect(
    (await api(ctx, "PUT", "data", { pluginId: "p", key: "other", text: "x" }))
      .status,
  ).toBe(404);

  await run(setEnabled(ctx, "p", false));
  expect((await write("off")).status).toBe(404);
  // SAFETY: GET /state answers PersonalPluginsState.
  expect(
    ((await (await api(ctx, "GET", "state")).json()) as { plugins: [] })
      .plugins,
  ).toEqual([]);
  await run(setEnabled(ctx, "p", true));

  await run(uninstall(ctx, "p"));
  expect(rows.has("data:p:week")).toBe(false);
  expect(rows.has("name:status")).toBe(false);
  expect(repos.get("user1.p")).toHaveLength(1);
  expect((await write("gone")).status).toBe(404);

  await run(deleteHistory(ctx, "p"));
  expect(repos.has("user1.p")).toBe(false);
  expect(rows.has("plugin:p")).toBe(false);
});

test("browser routes need the opt-in; cross-origin writes are refused", async () => {
  const { ctx } = setup();
  expect((await api(ctx, "GET", "state")).status).toBe(200);
  expect((await api(ctx, "GET", "list")).status).toBe(403);
  expect(
    (await api(ctx, "PUT", "enabled", { id: "p", enabled: true })).status,
  ).toBe(403);
  const crossOrigin = await Effect.runPromise(
    handlePersonalPluginsRequest(
      new Request("https://app.test/api/personal-plugins/opt-in", {
        method: "PUT",
        headers: {
          origin: "https://evil.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
      ctx,
    ),
  );
  expect(crossOrigin.status).toBe(403);
  expect((await api(ctx, "GET", "list")).status).toBe(403);
});

test("account deletion deletes every plugin repo the account recorded", async () => {
  const { ctx } = setup();
  await run(savePlugin(ctx, { definition: chips("a", "x"), note: "a" }));
  await run(savePlugin(ctx, { definition: chips("b", "y"), note: "b" }));
  await run(uninstall(ctx, "b"));
  const deleted: string[] = [];
  const artifacts = {
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  };
  expect(await deleteAllPluginRepos(artifacts, ctx.kv)).toBe(2);
  expect(deleted.sort()).toEqual(["user1.a", "user1.b"]);
});
