import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { fail, type JsonObject, VERSION } from "./core.js";

type Field = { wire: string; type: "string" | "boolean" | "integer" };
type Definition = {
  tool: string;
  positional?: string;
  many?: boolean;
  fields: Record<string, Field>;
};
const string = (wire: string): Field => ({ wire, type: "string" });
const boolean = (wire: string): Field => ({ wire, type: "boolean" });
const parent = { parent: string("parentId") };
const kind = { task: boolean("isTask"), kind: string("kind") };
const daily = { date: string("date"), "time-zone": string("timeZone") };
const position = { position: string("position") };

export const commands = {
  outline: {
    tool: "get_outline",
    positional: "nodeId",
    fields: { "max-depth": { wire: "maxDepth", type: "integer" } },
  },
  search: { tool: "search_nodes", positional: "query", fields: {} },
  add: {
    tool: "add_node",
    positional: "text",
    fields: { ...parent, ...position, ...kind },
  },
  subtree: {
    tool: "add_subtree",
    fields: { ...parent, ...position, ...daily },
  },
  update: {
    tool: "update_node",
    positional: "nodeId",
    fields: {
      text: string("text"),
      ...kind,
      completed: boolean("completed"),
      collapsed: boolean("collapsed"),
    },
  },
  delete: { tool: "delete_node", positional: "nodeId", fields: {} },
  move: {
    tool: "move_nodes",
    positional: "nodeIds",
    many: true,
    fields: { parent: string("newParentId"), ...position },
  },
  today: {
    tool: "add_to_today",
    positional: "text",
    fields: { ...kind, ...daily },
  },
  mirror: { tool: "mirror_node", positional: "nodeId", fields: parent },
  "mirror-today": {
    tool: "mirror_to_today",
    positional: "nodeId",
    fields: daily,
  },
  "import-opml": {
    tool: "import_opml",
    fields: { ...parent, ...daily, "dry-run": boolean("dryRun") },
  },
  "export-opml": { tool: "export_opml", positional: "nodeId", fields: {} },
} satisfies Record<string, Definition>;

export interface Parsed {
  command: string;
  tool?: string;
  fields: JsonObject;
  server?: string;
  input?: string;
  args?: string;
  file?: string;
  textFile?: string;
  json: boolean;
  yes: boolean;
  insecure: boolean;
  noBrowser: boolean;
  toolHelp?: string;
}

const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional);
type FileFlags = {
  textFile?: ReturnType<typeof optionalString>;
  file?: ReturnType<typeof optionalString>;
};
const switchFlag = (name: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false));
const inputs = {
  input: optionalString("input").pipe(
    Flag.withDescription("JSON argument object from FILE or - for stdin"),
  ),
  args: optionalString("args").pipe(
    Flag.withDescription(
      "Inline JSON argument object; mutually exclusive with --input",
    ),
  ),
};

// Effect CLI owns lexing, typed flags, help, completions, and command dispatch.
export const parse = Effect.fn("CLI.parse")(function* (
  argv: readonly string[],
) {
  let selected: Parsed | null = null;
  const messages: Array<ReadonlyArray<unknown>> = [];
  const output = yield* Console.Console;
  const root = Command.make("dotflowy").pipe(
    Command.withDescription(
      "Full Dotflowy MCP access. Spoilers are redacted; exports are not lossless backups.",
    ),
    Command.withSharedFlags({
      server: optionalString("server"),
      json: switchFlag("json"),
      yes: switchFlag("yes"),
    }),
  );
  const capture = Effect.fnUntraced(function* (
    command: string,
    values: Partial<Parsed> = {},
  ) {
    const global = yield* root;
    selected = {
      command,
      fields: {},
      insecure: false,
      noBrowser: false,
      ...global,
      server: Option.getOrUndefined(global.server),
      ...values,
    };
  });
  const friendly = Object.entries<Definition>(commands).map(
    ([name, definition]) => {
      const fields: Record<
        string,
        Flag.Flag<Option.Option<string | boolean | number>>
      > = {};
      for (const [flag, field] of Object.entries(definition.fields)) {
        const parameter: Flag.Flag<string | boolean | number> =
          field.type === "boolean"
            ? Flag.Boolean(flag)
            : field.type === "integer"
              ? Flag.Int(flag)
              : Flag.String(flag);
        fields[field.wire] = parameter.pipe(Flag.optional);
      }
      const files: FileFlags = {};
      if (["add", "today", "update"].includes(name))
        files.textFile = optionalString("text-file");
      if (name === "import-opml") files.file = optionalString("file");
      return Command.make(
        name,
        {
          ...inputs,
          fields,
          positional: Argument.String(definition.positional ?? "value").pipe(
            Argument.variadic({
              max: definition.many ? undefined : definition.positional ? 1 : 0,
            }),
          ),
          files,
        },
        Effect.fnUntraced(function* (values) {
          const args: JsonObject = {};
          for (const [wire, value] of Object.entries(values.fields))
            if (Option.isSome(value)) args[wire] = value.value;
          if (definition.positional && values.positional[0] !== undefined) {
            args[definition.positional] = definition.many
              ? [...values.positional]
              : values.positional[0];
          }
          yield* capture(name, {
            tool: definition.tool,
            fields: args,
            input: Option.getOrUndefined(values.input),
            args: Option.getOrUndefined(values.args),
            textFile: values.files.textFile
              ? Option.getOrUndefined(values.files.textFile)
              : undefined,
            file: values.files.file
              ? Option.getOrUndefined(values.files.file)
              : undefined,
          });
        }),
      ).pipe(
        Command.withDescription(
          `Call ${definition.tool}. Use dotflowy tools ${definition.tool} for the full server schema.`,
        ),
      );
    },
  );
  const cli = root.pipe(
    Command.withSubcommands([
      ...friendly,
      Command.make(
        "call",
        { tool: Argument.String("tool"), ...inputs },
        (values) =>
          capture("call", {
            tool: values.tool,
            input: Option.getOrUndefined(values.input),
            args: Option.getOrUndefined(values.args),
          }),
      ),
      Command.make(
        "tools",
        { tool: Argument.String("tool").pipe(Argument.optional) },
        (values) =>
          capture("tools", { toolHelp: Option.getOrUndefined(values.tool) }),
      ),
      Command.make(
        "login",
        {
          insecure: switchFlag("insecure-storage"),
          noBrowser: switchFlag("no-browser"),
        },
        (values) => capture("login", values),
      ),
      Command.make("logout", {}, () => capture("logout")),
      Command.make("status", {}, () => capture("status")),
    ]),
  );
  yield* Command.runWith(cli, { version: VERSION, renderErrors: false })(
    argv.length ? argv : ["--help"],
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Console.Console, {
      ...output,
      log: (...args) => {
        messages.push(args);
      },
    }),
    Effect.mapError(() =>
      fail(
        "Invalid command usage. Run dotflowy COMMAND --help for options.",
        2,
      ),
    ),
  );
  for (const message of messages) yield* Console.log(...message);
  // The command handler runs inside runWith; built-in help/version leave it unset.
  return yield* Effect.sync(() => selected);
});

export function mergeInput(
  parsed: Parsed,
  input: JsonObject,
  timeZone: string,
): JsonObject {
  const args = { ...input };
  if (parsed.input !== undefined && parsed.args !== undefined)
    throw fail("Use --input or --args, not both.", 2);
  for (const [name, value] of Object.entries(parsed.fields)) {
    if (Object.hasOwn(args, name))
      throw fail(`Supply ${name} only once (input or command argument).`, 2);
    args[name] = value;
  }
  if (
    ["today", "mirror-today"].includes(parsed.command) &&
    args.timeZone == null &&
    args.date == null
  )
    args.timeZone = timeZone;
  if (parsed.tool === "delete_node" && !parsed.yes)
    throw fail(
      "Deletion includes the whole subtree. Pass --yes to confirm.",
      2,
    );
  return args;
}
