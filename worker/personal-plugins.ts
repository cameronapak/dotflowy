// Personal plugins (ADR 0095): an account's own agent authors declarative
// plugins over MCP; only that account sees them.
//
// Gates, all required, all checked server-side on every request:
//   1. PERSONAL_PLUGINS is the exact string "true" and the ARTIFACTS binding
//      exists. Otherwise the routes 404 and the MCP tools are not listed.
//   2. A paid plan, and the billing id is in PERSONAL_PLUGINS_USERS when that
//      list is set (owner-first beta).
//   3. The account opted in (Cmd+K "Enable personal plugins (beta)"). Before
//      that, MCP lists only the read-only guide.
//
// Storage:
//   - Source and history: one Artifacts repo per plugin (personal-plugin-source.ts).
//   - Kv collection "personal-plugins" in the user's DO, not in KV_COLLECTIONS,
//     so /api/kv can't reach it. Rows: `optin`; `plugin:<id>` (repo, user
//     switch, active version and its definition, which is what the browser
//     renders); `name:<component>` claims, one owner per component name; and
//     `data:<pluginId>:<key>` notepad text. Activation writes the pointer and
//     the claims in one compare-and-set, so a race loses cleanly.

import { Data, Effect, Option, Schema } from "effect";

import type { Plan } from "./plan";

import { RESERVED_COMPONENT_NAMES } from "../src/data/comark";
import {
  decodeDefinition,
  definitionProblem,
  notepadKeys,
  PersonalPluginDefinition,
  PLUGIN_ID,
  type PersonalPluginsState,
  type PersonalPluginSummary,
} from "../src/data/personal-plugins";
import { type ToolDef, ToolError } from "./mcp-tools";
import { artifactsSource, type PluginSource } from "./personal-plugin-source";

export const COLLECTION = "personal-plugins";

export interface PersonalPluginsEnv {
  PERSONAL_PLUGINS?: string;
  /** Optional comma-separated Better Auth user ids allowed in the beta. */
  PERSONAL_PLUGINS_USERS?: string;
  ARTIFACTS?: Artifacts;
}

/** The release flag and the storage binding: whether the feature exists. */
export const personalPluginsDeployed = (
  env: PersonalPluginsEnv,
): env is PersonalPluginsEnv & { ARTIFACTS: Artifacts } =>
  env.PERSONAL_PLUGINS === "true" && env.ARTIFACTS !== undefined;

/** Whether this billing account may use personal plugins at all. */
export function personalPluginsEligible(
  env: PersonalPluginsEnv,
  billingUserId: string,
  plan: Plan,
): boolean {
  if (!personalPluginsDeployed(env) || plan === "free") return false;
  const allow = (env.PERSONAL_PLUGINS_USERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allow.length === 0 || allow.includes(billingUserId);
}

/** The DO methods this module uses. The DO stub satisfies it; tests fake it. */
export interface PluginKv {
  getKv(collection: string): unknown[] | Promise<unknown[]>;
  upsertKv(
    collection: string,
    rows: readonly { key: string; value: unknown }[],
  ): void | Promise<void>;
  compareAndSetKv(
    collection: string,
    expected: readonly { key: string; value: unknown }[],
    upserts: readonly { key: string; value: unknown }[],
    deletes: readonly string[],
  ): boolean | Promise<boolean>;
}

export interface PluginContext {
  kv: PluginKv;
  source: PluginSource;
  /** The resolved DO name; repos are named `<doName>.<pluginId>`. */
  doName: string;
}

export const pluginContext = (
  env: PersonalPluginsEnv & { ARTIFACTS: Artifacts },
  kv: PluginKv,
  doName: string,
): PluginContext => ({ kv, source: artifactsSource(env.ARTIFACTS), doName });

export class PluginError extends Data.TaggedError("PluginError")<{
  reason: string;
  status: number;
}> {}

const fail = (reason: string, status = 400) =>
  Effect.fail(new PluginError({ reason, status }));

const attempt = <A>(what: string, run: () => Promise<A> | A) =>
  Effect.tryPromise({
    try: async () => run(),
    catch: (error) =>
      new PluginError({
        reason:
          `${what} failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            300,
          ),
        status: 502,
      }),
  });

// --- Rows ---------------------------------------------------------------------

const PluginRow = Schema.Struct({
  key: Schema.String,
  id: Schema.String,
  repo: Schema.String,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  active: Schema.NullOr(
    Schema.Struct({
      version: Schema.String,
      definition: PersonalPluginDefinition,
    }),
  ),
});
type PluginRow = typeof PluginRow.Type;
const ClaimRow = Schema.Struct({ key: Schema.String, pluginId: Schema.String });
const DataRow = Schema.Struct({ key: Schema.String, text: Schema.String });

interface Snapshot {
  optedIn: boolean;
  plugins: Map<string, PluginRow>;
  /** component name -> owning plugin id */
  claims: Map<string, string>;
  data: Map<string, string>;
  /** Every row exactly as stored, for compare-and-set expectations. */
  raw: Map<string, unknown>;
}

const Keyed = Schema.Struct({ key: Schema.String });

const pluginKey = (id: string) => `plugin:${id}`;
const claimKey = (name: string) => `name:${name}`;
const dataKey = (pluginId: string, key: string) => `data:${pluginId}:${key}`;

const load = (kv: PluginKv) =>
  Effect.map(
    attempt("reading plugins", () => kv.getKv(COLLECTION)),
    (rows): Snapshot => {
      const snap: Snapshot = {
        optedIn: false,
        plugins: new Map(),
        claims: new Map(),
        data: new Map(),
        raw: new Map(),
      };
      for (const row of rows) {
        const keyed = Schema.decodeUnknownOption(Keyed)(row);
        if (Option.isNone(keyed)) continue;
        const key = keyed.value.key;
        snap.raw.set(key, row);
        if (key === "optin") snap.optedIn = true;
        else if (key.startsWith("plugin:")) {
          const p = Schema.decodeUnknownOption(PluginRow)(row);
          if (Option.isSome(p)) snap.plugins.set(p.value.id, p.value);
        } else if (key.startsWith("name:")) {
          const c = Schema.decodeUnknownOption(ClaimRow)(row);
          if (Option.isSome(c))
            snap.claims.set(key.slice("name:".length), c.value.pluginId);
        } else if (key.startsWith("data:")) {
          const d = Schema.decodeUnknownOption(DataRow)(row);
          if (Option.isSome(d)) snap.data.set(key, d.value.text);
        }
      }
      return snap;
    },
  );

const expectRow = (snap: Snapshot, key: string) => ({
  key,
  value: snap.raw.get(key) ?? null,
});

const componentNames = (definition: PersonalPluginDefinition | undefined) =>
  (definition?.components ?? []).map((c) => c.name);

/** The writes that make `definition` this plugin's active version: claim its
 *  component names and release the ones it no longer has. Fails when another
 *  plugin owns a name. */
function claimWrites(
  snap: Snapshot,
  id: string,
  definition: PersonalPluginDefinition | null,
) {
  const names = componentNames(definition ?? undefined);
  const taken = names.find((n) => {
    const owner = snap.claims.get(n);
    return owner !== undefined && owner !== id;
  });
  const released = [...snap.claims]
    .filter(([name, owner]) => owner === id && !names.includes(name))
    .map(([name]) => claimKey(name));
  return {
    taken: taken ? { name: taken, owner: snap.claims.get(taken)! } : null,
    expected: [
      ...names.map((n) => expectRow(snap, claimKey(n))),
      ...released.map((k) => expectRow(snap, k)),
    ],
    upserts: names.map((n) => ({
      key: claimKey(n),
      value: { key: claimKey(n), pluginId: id },
    })),
    deletes: released,
  };
}

const cas = (
  ctx: PluginContext,
  expected: readonly { key: string; value: unknown }[],
  upserts: readonly { key: string; value: unknown }[],
  deletes: readonly string[] = [],
) =>
  attempt("saving", () =>
    ctx.kv.compareAndSetKv(COLLECTION, expected, upserts, deletes),
  );

const rowWrite = (row: PluginRow) => ({ key: row.key, value: row });

// --- Operations ---------------------------------------------------------------

/** Decode at the boundary, then apply the rules a schema cannot say. */
const validDefinition = (raw: typeof SaveInput.Type.definition) =>
  decodeDefinition(raw).pipe(
    Effect.mapError(
      (issue) =>
        new PluginError({
          reason: `Definition rejected: ${issue.message.slice(0, 800)}`,
          status: 400,
        }),
    ),
    Effect.flatMap((definition) => {
      const problem = definitionProblem(definition);
      return problem
        ? fail(`Definition rejected: ${problem}`)
        : Effect.succeed(definition);
    }),
  );

export const SaveInput = Schema.Struct({
  definition: Schema.Unknown,
  note: Schema.String.check(Schema.isMaxLength(300)),
  activate: Schema.optionalKey(Schema.Boolean),
  baseVersion: Schema.optionalKey(Schema.String),
});

export const savePlugin = (ctx: PluginContext, input: typeof SaveInput.Type) =>
  Effect.gen(function* () {
    const definition = yield* validDefinition(input.definition);
    const activate = input.activate !== false;
    let snap = yield* load(ctx.kv);
    if (activate) {
      const { taken } = claimWrites(snap, definition.id, definition);
      if (taken)
        return yield* fail(
          `Component "${taken.name}" already belongs to plugin "${taken.owner}". Rename it, or remove that plugin first.`,
          409,
        );
    }
    let row = snap.plugins.get(definition.id);
    if (!row) {
      // Record the repo before it exists, so account deletion and Settings
      // always know about every repo, even when a later step fails.
      row = {
        key: pluginKey(definition.id),
        id: definition.id,
        repo: `${ctx.doName}.${definition.id}`,
        installed: true,
        enabled: true,
        active: null,
      };
      if (!(yield* cas(ctx, [expectRow(snap, row.key)], [rowWrite(row)])))
        return yield* fail("This plugin changed at the same time. Retry.", 409);
      snap = yield* load(ctx.kv);
      row = snap.plugins.get(definition.id) ?? row;
    }
    const committed = yield* attempt("saving the version", () =>
      ctx.source.commit(
        row.repo,
        `${JSON.stringify(definition, null, 2)}\n`,
        input.note,
        input.baseVersion,
      ),
    );
    if (!committed.ok)
      return yield* fail(
        `Another version was saved first (latest: ${committed.head ?? "none"}). Read the plugin again, then save with that baseVersion.`,
        409,
      );
    const next: PluginRow = activate
      ? {
          ...row,
          installed: true,
          active: { version: committed.version, definition },
        }
      : row;
    const claims = activate
      ? claimWrites(snap, definition.id, definition)
      : { expected: [], upserts: [], deletes: [] };
    const landed =
      next === row ||
      (yield* cas(
        ctx,
        [expectRow(snap, row.key), ...claims.expected],
        [rowWrite(next), ...claims.upserts],
        claims.deletes,
      ));
    if (!landed)
      return yield* fail(
        `Version ${committed.version} is saved in history, but the plugin changed at the same time, so it is not live. Activate it with activate_personal_plugin_version.`,
        409,
      );
    const result = {
      id: definition.id,
      version: committed.version,
      live: activate && next.enabled,
    };
    return activate && !next.enabled
      ? { ...result, note: "The user switched this plugin off in Settings." }
      : result;
  });

export const activateVersion = (
  ctx: PluginContext,
  id: string,
  version: string | null,
) =>
  Effect.gen(function* () {
    const snap = yield* load(ctx.kv);
    const row = snap.plugins.get(id);
    if (!row) return yield* fail(`No personal plugin "${id}".`, 404);
    let active: PluginRow["active"] = null;
    if (version !== null) {
      const text = yield* attempt("reading the version", () =>
        ctx.source.read(row.repo, version),
      );
      if (text === null)
        return yield* fail(`Plugin "${id}" has no version ${version}.`, 404);
      const definition = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: () =>
          new PluginError({
            reason: `Version ${version} is not valid JSON.`,
            status: 400,
          }),
      }).pipe(Effect.flatMap(validDefinition));
      if (definition.id !== id)
        return yield* fail(`Version ${version} belongs to another plugin.`);
      active = { version, definition };
    }
    const claims = claimWrites(snap, id, active?.definition ?? null);
    if (claims.taken)
      return yield* fail(
        `Component "${claims.taken.name}" already belongs to plugin "${claims.taken.owner}".`,
        409,
      );
    const next: PluginRow = {
      ...row,
      installed: active !== null || row.installed,
      active,
    };
    if (
      !(yield* cas(
        ctx,
        [expectRow(snap, row.key), ...claims.expected],
        [rowWrite(next), ...claims.upserts],
        claims.deletes,
      ))
    )
      return yield* fail("This plugin changed at the same time. Retry.", 409);
    return { id, activeVersion: version };
  });

export const setEnabled = (ctx: PluginContext, id: string, enabled: boolean) =>
  Effect.gen(function* () {
    const snap = yield* load(ctx.kv);
    const row = snap.plugins.get(id);
    if (!row) return yield* fail(`No personal plugin "${id}".`, 404);
    if (
      !(yield* cas(
        ctx,
        [expectRow(snap, row.key)],
        [rowWrite({ ...row, enabled })],
      ))
    )
      return yield* fail("This plugin changed at the same time. Retry.", 409);
    return { id, enabled };
  });

/** Remove from this account: off everywhere, names released, notepad data
 *  deleted. The repo and its history stay until deleteHistory. */
export const uninstall = (ctx: PluginContext, id: string) =>
  Effect.gen(function* () {
    const snap = yield* load(ctx.kv);
    const row = snap.plugins.get(id);
    if (!row) return yield* fail(`No personal plugin "${id}".`, 404);
    const claims = claimWrites(snap, id, null);
    const data = [...snap.data.keys()].filter((k) =>
      k.startsWith(`data:${id}:`),
    );
    if (
      !(yield* cas(
        ctx,
        [expectRow(snap, row.key), ...claims.expected],
        [rowWrite({ ...row, installed: false, active: null })],
        [...claims.deletes, ...data],
      ))
    )
      return yield* fail("This plugin changed at the same time. Retry.", 409);
    return { id, removed: true, deletedDataRows: data.length };
  });

/** Remove the plugin and permanently delete its repo and every version. */
export const deleteHistory = (ctx: PluginContext, id: string) =>
  Effect.gen(function* () {
    const snap = yield* load(ctx.kv);
    const row = snap.plugins.get(id);
    if (!row) return yield* fail(`No personal plugin "${id}".`, 404);
    // Repo first: if this fails, the row still points at it for a retry.
    yield* attempt("deleting history", () => ctx.source.remove(row.repo));
    const claims = claimWrites(snap, id, null);
    const data = [...snap.data.keys()].filter((k) =>
      k.startsWith(`data:${id}:`),
    );
    if (
      !(yield* cas(
        ctx,
        [expectRow(snap, row.key), ...claims.expected],
        [],
        [row.key, ...claims.deletes, ...data],
      ))
    )
      return yield* fail("This plugin changed at the same time. Retry.", 409);
    return { id, deleted: true };
  });

export const listPlugins = (ctx: PluginContext) =>
  Effect.map(load(ctx.kv), (snap) => [...snap.plugins.values()].map(summary));

export const pluginDetail = (ctx: PluginContext, id: string) =>
  Effect.gen(function* () {
    const snap = yield* load(ctx.kv);
    const row = snap.plugins.get(id);
    if (!row) return yield* fail(`No personal plugin "${id}".`, 404);
    const versions = yield* attempt("reading history", () =>
      ctx.source.history(row.repo, 100),
    );
    return {
      ...summary(row),
      activeDefinition: row.active?.definition ?? null,
      versions,
    };
  });

function summary(row: PluginRow): PersonalPluginSummary {
  const d = row.active?.definition;
  return {
    id: row.id,
    name: d?.name ?? row.id,
    description: d?.description ?? null,
    installed: row.installed,
    enabled: row.enabled,
    activeVersion: row.active?.version ?? null,
    parts: d
      ? [
          ...(d.components ?? []).map((c) => ({
            syntax: c.kind === "inline" ? `:${c.name}[…]` : `::${c.name}`,
            what: c.view,
          })),
          ...(d.commands ?? []).map((c) => ({
            syntax: null,
            what: `/ ${c.label}`,
          })),
          ...(d.subheader ? [{ syntax: null, what: "subheader" }] : []),
          ...(d.panel ? [{ syntax: null, what: "panel" }] : []),
        ]
      : [],
  };
}

const renderState = (snap: Snapshot): PersonalPluginsState => ({
  optedIn: snap.optedIn,
  plugins: snap.optedIn
    ? [...snap.plugins.values()].flatMap((row) =>
        row.installed && row.enabled && row.active ? [row.active] : [],
      )
    : [],
});

/** The notepad a request names, if a live plugin declares it. */
function liveNotepad(snap: Snapshot, pluginId: string, key: string) {
  const row = snap.plugins.get(pluginId);
  const definition =
    row?.installed && row.enabled ? row.active?.definition : undefined;
  return definition && notepadKeys(definition).includes(key);
}

/** Account deletion: delete every plugin repo this DO knows about. Runs
 *  before the DO wipe; a failure aborts the deletion so nothing is orphaned. */
export async function deleteAllPluginRepos(
  artifacts: Pick<Artifacts, "delete">,
  kv: PluginKv,
): Promise<number> {
  const rows = await kv.getKv(COLLECTION);
  const repos = rows.flatMap((row) => {
    const p = Schema.decodeUnknownOption(PluginRow)(row);
    return Option.isSome(p) ? [p.value.repo] : [];
  });
  for (const repo of repos) await artifacts.delete(repo);
  return repos.length;
}

// --- MCP tools ------------------------------------------------------------------

const GUIDE = `Personal plugins add views and commands to this user's own Dotflowy, and nobody else's. A plugin is a JSON definition, not code: Dotflowy renders it with its own components.

Definition fields (unknown keys are rejected):
- id: lowercase, digits, hyphens (max 40). name (max 60). description (optional).
- components (max 12): {name, kind, view, tone?, description?, hidesChildren?}
  - kind "inline", view "chip": write \`:name[label]{tone="green"}\` anywhere in a bullet. The [label] is required.
  - kind "block", view "progress": a bullet starting with \`::name\` shows how many tasks under it are done.
  - kind "block", view "board": a bullet starting with \`::name\` shows its children as columns and grandchildren as cards. A column bullet ending in {tone="green"} colors that column. Set hidesChildren:true so the outline shows the board instead of the bullets until the user zooms in.
  - Names are lowercase (max 31) and unique across the user's plugins. Reserved: ${[...RESERVED_COMPONENT_NAMES].join(", ")}.
- commands (max 8): {label, description?, insert, children?}. Adds to the user's \`/\` menu. insert is one line of text placed at the caret; a template starting with \`::\` goes at the start of the bullet. children (3 levels, 12 per level) are created under the bullet when it has none yet.
- subheader: {when: "always" | "daily-note", blocks}. A compact band below the page header.
- panel: {title, blocks}. A side panel the user opens from Cmd+K ("Open <title>").
- blocks (1 to 12): {type:"heading", text} | {type:"text", text, muted?} | {type:"list", items:[{title, subtitle?, accessory?, tone?}]} | {type:"chips", items:[{label, tone?}]} | {type:"notepad", key, placeholder?} (plugin-owned text the user types).
- tones: neutral, blue, green, yellow, red, purple.

Versions: every save is a new version in the plugin's own history. save_personal_plugin makes it live unless activate is false. Pass baseVersion (from get_personal_plugin) to refuse the save if someone else saved first. activate_personal_plugin_version rolls back or forward. remove_personal_plugin takes it out of Dotflowy but keeps its history; delete_personal_plugin_history deletes the history for good.

To place a component, write its syntax into a bullet with the normal Dotflowy tools. If the plugin is removed, that text stays as readable text.

Example: {"id":"reading","name":"Reading","components":[{"name":"status","kind":"inline","view":"chip","tone":"blue"},{"name":"shelf","kind":"block","view":"board","hidesChildren":true}],"commands":[{"label":"Reading shelf","insert":"::shelf","children":[{"text":"To read {tone=\\"blue\\"}"},{"text":"Reading {tone=\\"yellow\\"}"},{"text":"Done {tone=\\"green\\"}"}]}]}`;

const OFF_NOTE =
  "Personal plugins are off for this account. The user can turn them on in Dotflowy: press Cmd+K and choose Enable personal plugins (beta). Then reconnect to see the authoring tools.";

const IdInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(PLUGIN_ID)),
});

const asTool = <A>(effect: Effect.Effect<A, PluginError>) =>
  effect.pipe(
    Effect.map((value) => JSON.stringify(value, null, 2)),
    Effect.mapError((e) => new ToolError({ reason: e.reason })),
  );

/** The MCP tools for an eligible account. Before opt-in, only the guide. */
export function personalPluginTools(
  ctx: PluginContext,
  optedIn: boolean,
): ToolDef[] {
  const guide: ToolDef = {
    name: "get_personal_plugin_guide",
    title: "Get personal plugin guide",
    description:
      "Explain how to write a personal Dotflowy plugin: components, commands, subheader, panel, and versions. Call before saving one.",
    input: Schema.Record(Schema.String, Schema.Unknown),
    readOnly: true,
    destructive: false,
    handle: () => Effect.succeed(optedIn ? GUIDE : `${OFF_NOTE}\n\n${GUIDE}`),
  };
  if (!optedIn) return [guide];
  return [
    guide,
    {
      name: "list_personal_plugins",
      title: "List personal plugins",
      description:
        "List this account's personal plugins, whether each is on, and its live version.",
      input: Schema.Record(Schema.String, Schema.Unknown),
      readOnly: true,
      destructive: false,
      handle: () => asTool(listPlugins(ctx)),
    },
    {
      name: "get_personal_plugin",
      title: "Get personal plugin",
      description:
        "Read one personal plugin: its live definition and its version history, newest first.",
      input: IdInput,
      readOnly: true,
      destructive: false,
      handle: (input: typeof IdInput.Type) =>
        asTool(pluginDetail(ctx, input.id)),
    },
    {
      name: "save_personal_plugin",
      title: "Save personal plugin",
      description:
        "Validate a definition and save it as a new version of plugin `definition.id`. It goes live in this user's Dotflowy unless activate is false.",
      input: SaveInput,
      readOnly: false,
      destructive: false,
      handle: (input: typeof SaveInput.Type) => asTool(savePlugin(ctx, input)),
    },
    {
      name: "activate_personal_plugin_version",
      title: "Activate personal plugin version",
      description:
        "Make a saved version live (roll back or forward). version null keeps the plugin but shows nothing.",
      input: Schema.Struct({
        id: Schema.String.check(Schema.isPattern(PLUGIN_ID)),
        version: Schema.NullOr(Schema.String),
      }),
      readOnly: false,
      destructive: false,
      handle: (input: { id: string; version: string | null }) =>
        asTool(activateVersion(ctx, input.id, input.version)),
    },
    {
      name: "remove_personal_plugin",
      title: "Remove personal plugin",
      description:
        "Take a plugin out of this user's Dotflowy and delete its notepad data. Its version history is kept; notes that use its syntax stay as text.",
      input: IdInput,
      readOnly: false,
      destructive: true,
      handle: (input: typeof IdInput.Type) => asTool(uninstall(ctx, input.id)),
    },
    {
      name: "delete_personal_plugin_history",
      title: "Delete personal plugin history",
      description:
        "Permanently delete a plugin and every saved version. Cannot be undone. Requires confirm: true.",
      input: Schema.Struct({
        id: Schema.String.check(Schema.isPattern(PLUGIN_ID)),
        confirm: Schema.Literal(true),
      }),
      readOnly: false,
      destructive: true,
      handle: (input: { id: string }) => asTool(deleteHistory(ctx, input.id)),
    },
  ];
}

/** Whether this account opted in; one kv read. */
export const isOptedIn = (kv: PluginKv) =>
  Effect.map(load(kv), (snap) => snap.optedIn);

// --- Browser routes (session) ---------------------------------------------------

const OptInBody = Schema.Struct({ enabled: Schema.Boolean });
const EnabledBody = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
});
const ActivateBody = Schema.Struct({
  id: Schema.String,
  version: Schema.NullOr(Schema.String),
});
const IdBody = Schema.Struct({ id: Schema.String });
const DeleteBody = Schema.Struct({
  id: Schema.String,
  confirm: Schema.Literal(true),
});
const DataBody = Schema.Struct({
  pluginId: Schema.String,
  key: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
});

const body = <S extends Schema.Top & { readonly DecodingServices: never }>(
  request: Request,
  schema: S,
) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new PluginError({ reason: "invalid body", status: 400 }),
  }).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
        raw,
      ).pipe(
        Effect.mapError(
          () => new PluginError({ reason: "invalid body", status: 400 }),
        ),
      ),
    ),
  );

const noStore = { "cache-control": "private, no-store" };

/** /api/personal-plugins/* for an eligible, signed-in account. */
export function handlePersonalPluginsRequest(
  request: Request,
  ctx: PluginContext,
): Effect.Effect<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/personal-plugins".length);
  const route = `${request.method} ${path}`;
  return Effect.gen(function* () {
    if (
      request.method !== "GET" &&
      request.headers.has("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return yield* fail("invalid origin", 403);
    if (route === "GET /state")
      return Response.json(renderState(yield* load(ctx.kv)), {
        headers: noStore,
      });
    if (route === "PUT /opt-in") {
      const { enabled } = yield* body(request, OptInBody);
      // Turning off keeps every plugin and its history; it only stops them
      // rendering and hides the authoring tools.
      yield* cas(
        ctx,
        [],
        enabled
          ? [{ key: "optin", value: { key: "optin", at: Date.now() } }]
          : [],
        enabled ? [] : ["optin"],
      );
      return Response.json(renderState(yield* load(ctx.kv)), {
        headers: noStore,
      });
    }
    // Everything else needs the opt-in.
    const snap = yield* load(ctx.kv);
    if (!snap.optedIn)
      return yield* fail("Personal plugins are off for this account.", 403);
    switch (route) {
      case "GET /list":
        return Response.json([...snap.plugins.values()].map(summary), {
          headers: noStore,
        });
      case "GET /versions": {
        const id = url.searchParams.get("id") ?? "";
        return Response.json(yield* pluginDetail(ctx, id), {
          headers: noStore,
        });
      }
      case "PUT /enabled": {
        const b = yield* body(request, EnabledBody);
        return Response.json(yield* setEnabled(ctx, b.id, b.enabled));
      }
      case "POST /activate": {
        const b = yield* body(request, ActivateBody);
        return Response.json(yield* activateVersion(ctx, b.id, b.version));
      }
      case "POST /uninstall": {
        const b = yield* body(request, IdBody);
        return Response.json(yield* uninstall(ctx, b.id));
      }
      case "POST /delete-history": {
        const b = yield* body(request, DeleteBody);
        return Response.json(yield* deleteHistory(ctx, b.id));
      }
      case "GET /data": {
        const pluginId = url.searchParams.get("pluginId") ?? "";
        const key = url.searchParams.get("key") ?? "";
        if (!liveNotepad(snap, pluginId, key))
          return yield* fail("No live notepad with that key.", 404);
        return Response.json(
          { text: snap.data.get(dataKey(pluginId, key)) ?? "" },
          { headers: noStore },
        );
      }
      case "PUT /data": {
        const b = yield* body(request, DataBody);
        if (!liveNotepad(snap, b.pluginId, b.key))
          return yield* fail("No live notepad with that key.", 404);
        const key = dataKey(b.pluginId, b.key);
        yield* attempt("saving", () =>
          ctx.kv.upsertKv(COLLECTION, [{ key, value: { key, text: b.text } }]),
        );
        return Response.json({ ok: true });
      }
      default:
        return yield* fail("not found", 404);
    }
  }).pipe(
    Effect.catchTag("PluginError", (e) =>
      Effect.succeed(Response.json({ error: e.reason }, { status: e.status })),
    ),
  );
}
