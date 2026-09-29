import { Config, Effect, Option, Redacted, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const DEFAULT_SERVER = "https://app.dotflowy.com";

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.Number,
}) {}

export const fail = (message: string, exitCode = 1) =>
  new CliError({ message, exitCode });

const safeErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  if (typeof error.code === "number" && Number.isSafeInteger(error.code))
    return String(error.code);
  if (typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code))
    return error.code;
  return undefined;
};

// Never include native exception messages: they can contain tokens, URLs, or bodies.
// Callers may name a safe operation, and Node-style error codes are safe to expose.
export const io = <A>(
  message: string,
  run: (signal: AbortSignal) => Promise<A>,
  operation?: string,
) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      const details = [operation, safeErrorCode(error)]
        .filter((value) => value !== undefined)
        .join(": ");
      return fail(details ? `${message} [${details}]` : message);
    },
  });

export const decode = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  value: unknown,
  label: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => fail(`Invalid ${label}.`)),
  );

export const JsonObject = Schema.Record(Schema.String, Schema.Json);
export type JsonObject = {
  -readonly [K in keyof typeof JsonObject.Type]: (typeof JsonObject.Type)[K];
};

export const parseJson = (text: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => fail("Invalid JSON input.", 2),
  });

export function serverUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw fail(
      "Server must be an HTTPS origin (HTTP is allowed only on loopback).",
      2,
    );
  }
  return url.origin;
}

export const normalizeServer = (raw: string) =>
  Effect.try({
    try: () => serverUrl(raw),
    catch: () =>
      fail(
        "Server must be an HTTPS origin (HTTP is allowed only on loopback).",
        2,
      ),
  });

export const configuration = Effect.gen(function* () {
  const server = yield* Config.String("DOTFLOWY_SERVER").pipe(
    Config.withDefault(DEFAULT_SERVER),
  );
  const token = yield* Config.option(Config.Redacted("DOTFLOWY_TOKEN"));
  const appData = yield* Config.String("APPDATA").pipe(
    Config.withDefault(join(homedir(), "AppData", "Roaming")),
  );
  const xdg = yield* Config.String("XDG_CONFIG_HOME").pipe(
    Config.withDefault(join(homedir(), ".config")),
  );
  const directory = yield* Config.String("DOTFLOWY_CONFIG_DIR").pipe(
    Config.withDefault(
      join(process.platform === "win32" ? appData : xdg, "dotflowy"),
    ),
  );
  return {
    server,
    token: Option.isSome(token) ? Redacted.value(token.value) : undefined,
    directory,
  };
}).pipe(
  Effect.mapError(() => fail("Invalid CLI environment configuration.", 2)),
);

// Server-controlled text must not execute terminal escape sequences.
export const terminalText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
