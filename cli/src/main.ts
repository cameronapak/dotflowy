#!/usr/bin/env node
import { Effect, Predicate } from "effect";
import { createReadStream } from "node:fs";

import { accessToken, login } from "./auth.js";
import { parse, mergeInput } from "./commands.js";
import {
  CliError,
  configuration,
  decode,
  fail,
  io,
  JsonObject,
  normalizeServer,
  parseJson,
  terminalText,
} from "./core.js";
import { credentialStore } from "./credentials.js";
import { connect } from "./mcp.js";

const readInput = (path: string) =>
  io("Cannot read input file or stdin.", async () => {
    if (path === "-" && process.stdin.isTTY)
      throw new Error("Pipe input into stdin");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of path === "-"
      ? process.stdin
      : createReadStream(path)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16 * 1024 * 1024) throw new Error("Input too large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  });

const redactJson = (
  value: JsonObject[string],
  token: string,
): JsonObject[string] => {
  if (Predicate.isString(value)) return value.split(token).join("[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactJson(item, token));
  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value))
    return value;
  const redacted: JsonObject = {};
  for (const [key, nested] of Object.entries<JsonObject[string]>(value))
    redacted[key.split(token).join("[redacted]")] = redactJson(nested, token);
  return redacted;
};

const program = Effect.gen(function* () {
  const parsed = yield* parse(process.argv.slice(2));
  if (!parsed) return 0;
  const out = (value: JsonObject, text: string) =>
    console.log(parsed.json ? JSON.stringify(value) : terminalText(text));
  const config = yield* configuration;
  const server = yield* normalizeServer(parsed.server ?? config.server);
  if (parsed.command === "login") {
    if (config.token !== undefined)
      return yield* Effect.fail(
        fail(
          "Unset DOTFLOWY_TOKEN before login; it overrides saved credentials.",
          2,
        ),
      );
    if (parsed.insecure)
      console.error(
        "Warning: --insecure-storage saves credentials unencrypted in a user-only file.",
      );
    yield* login(
      server,
      config.directory,
      parsed.insecure,
      (url) =>
        console.error(`Open this URL in a browser on this machine:\n${url}`),
      !parsed.noBrowser,
    );
    out(
      { server, storage: parsed.insecure ? "file" : "keyring" },
      `Signed in to ${server}. Credentials saved in ${parsed.insecure ? "an unencrypted file" : "the OS credential store"}.`,
    );
    return 0;
  }
  if (parsed.command === "logout") {
    yield* credentialStore(config.directory, server).remove();
    out(
      { server, localCredentialsRemoved: true },
      "Saved local credentials removed. Server tokens are not revoked. Environment tokens are unchanged.",
    );
    return 0;
  }

  // Reject invalid or destructive input before any authenticated request.
  let args: JsonObject = {};
  if (parsed.tool) {
    const stdinCount = [parsed.input, parsed.textFile, parsed.file].filter(
      (v) => v === "-",
    ).length;
    if (stdinCount > 1)
      return yield* Effect.fail(fail("Only one input can consume stdin.", 2));
    if (parsed.input !== undefined || parsed.args !== undefined) {
      const raw =
        parsed.input !== undefined
          ? yield* readInput(parsed.input)
          : (parsed.args ?? "{}");
      args = yield* decode(
        JsonObject,
        yield* parseJson(raw),
        "argument object",
      );
    }
    for (const [field, path] of [
      ["text", parsed.textFile],
      ["opml", parsed.file],
    ] as const) {
      if (path !== undefined) {
        if (Object.hasOwn(args, field) || Object.hasOwn(parsed.fields, field))
          return yield* Effect.fail(fail(`Supply ${field} only once.`, 2));
        args[field] = yield* readInput(path);
      }
    }
    args = yield* Effect.try({
      try: () =>
        mergeInput(
          parsed,
          args,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      catch: (error) =>
        error instanceof CliError ? error : fail("Invalid command input.", 2),
    });
  }
  const token = yield* accessToken(server, config.directory, config.token);
  const client = yield* connect(server, token);
  const tools = yield* client.list();
  if (parsed.command === "status") {
    out(
      {
        server,
        authenticated: true,
        source: config.token !== undefined ? "environment" : "saved",
        serverInfo: client.serverInfo,
        toolCount: tools.length,
      },
      `Authenticated to ${server}. ${tools.length} tools discovered. Paid-plan access is checked when you call a tool.`,
    );
    return 0;
  }
  if (parsed.command === "tools") {
    const selected = parsed.toolHelp
      ? tools.filter((t) => t.name === parsed.toolHelp)
      : tools;
    if (!selected.length && parsed.toolHelp)
      return yield* Effect.fail(fail("Tool not found.", 2));
    out(
      { tools: selected },
      selected
        .map(
          (t) =>
            `${t.name}: ${t.description ?? ""}${parsed.toolHelp ? `\n${JSON.stringify(t.inputSchema, null, 2)}` : ""}`,
        )
        .join("\n"),
    );
    return 0;
  }
  const tool = tools.find((t) => t.name === parsed.tool);
  if (!tool)
    return yield* Effect.fail(fail("Tool not found. Run dotflowy tools.", 2));
  // New destructive tools inherit the same guard; a known deletion never relies on annotations.
  if (tool.annotations?.destructiveHint === true && !parsed.yes)
    return yield* Effect.fail(
      fail("This tool is destructive. Pass --yes to confirm.", 2),
    );
  const result = yield* client.invoke(
    tool.name,
    args,
    tool.annotations?.readOnlyHint !== true,
  );
  const text = result.content
    .map((block) =>
      Predicate.isString(block.text) ? block.text : JSON.stringify(block),
    )
    .join("\n");
  if (result.isError) {
    if (parsed.json) {
      console.log(JSON.stringify(redactJson(result.raw, token)));
    } else {
      console.error(terminalText(text.split(token).join("[redacted]")));
    }
  } else out(result.raw, text);
  return result.isError ? 4 : 0;
});

// One runtime boundary. Expected errors never print stacks or native secret-bearing causes.
const runnable = program.pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      const message = terminalText(error.message);
      console.error(
        process.argv.includes("--json")
          ? JSON.stringify({ error: { message, exitCode: error.exitCode } })
          : message,
      );
      return error.exitCode;
    }),
  ),
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    controller.abort();
    process.exitCode = 0;
  }
});
Effect.runPromise(runnable, { signal: controller.signal }).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    if (!controller.signal.aborted)
      console.error("Unexpected CLI failure. No request was retried.");
    process.exitCode = controller.signal.aborted ? 130 : 1;
  },
);
