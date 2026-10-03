/**
 * Temporary ADR 0061 operator CLI. Dry-run is the default and every mutating
 * command requires --execute. Batches are deliberately sequential.
 */

import { Schema } from "effect";

const OperationResultSchema = Schema.Struct({
  state: Schema.String,
  classification: Schema.optional(Schema.NullOr(Schema.String)),
  dryRun: Schema.optional(Schema.Struct({ classification: Schema.String })),
});
type OperationResult = Schema.Schema.Type<typeof OperationResultSchema>;

type Command =
  | "dry-run"
  | "migrate"
  | "migrate-with-recovery"
  | "retry"
  | "status"
  | "restore"
  | "preserve-classic"
  | "recover-classic"
  | "report";

interface Args {
  command: Command;
  api: string;
  userId?: string;
  email?: string;
  all: boolean;
  execute: boolean;
  out?: string;
  manifestHash?: string;
}

const DEFAULT_API = "https://app.dotflowy.com";

/** Restrict credential-bearing operator requests to owned or local origins. */
export function normalizeRetirementApiOrigin(input: string): string {
  const url = new URL(input);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const isDotflowy =
    url.hostname === "dotflowy.com" || url.hostname.endsWith(".dotflowy.com");
  const approvedTransport =
    (isDotflowy && url.protocol === "https:" && url.port === "") ||
    (isLoopback && (url.protocol === "http:" || url.protocol === "https:"));
  if (
    !approvedTransport ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "API must be an HTTPS dotflowy.com origin or an HTTP(S) loopback origin",
    );
  }
  return url.origin;
}

function usage(): void {
  console.error(`Usage:
  bun run lunora:retire [dry-run] (--user ID | --email EMAIL | --all)
  bun run lunora:retire migrate (--user ID | --email EMAIL | --all) --execute
  bun run lunora:retire migrate-with-recovery (--user ID | --email EMAIL) --execute
  bun run lunora:retire retry (--user ID | --email EMAIL) --execute
  bun run lunora:retire status [--user ID | --email EMAIL | --all]
  bun run lunora:retire restore (--user ID | --email EMAIL) --execute
  bun run lunora:retire preserve-classic (--user ID | --email EMAIL) --execute
  bun run lunora:retire recover-classic (--user ID | --email EMAIL) --manifest-hash HASH --execute
  bun run lunora:retire report [--user ID | --email EMAIL | --all] [--out FILE]

Options: --api URL (default DOTFLOWY_API or https://app.dotflowy.com)`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const commands: Command[] = [
    "dry-run",
    "migrate",
    "migrate-with-recovery",
    "retry",
    "status",
    "restore",
    "preserve-classic",
    "recover-classic",
    "report",
  ];
  let command: Command = "dry-run";
  let index = 0;
  const selected = commands.find((candidate) => candidate === argv[0]);
  if (selected) {
    command = selected;
    index++;
  }
  const args: Args = {
    command,
    api: process.env.DOTFLOWY_API ?? DEFAULT_API,
    all: false,
    execute: false,
  };
  while (index < argv.length) {
    const flag = argv[index++];
    if (flag === "--user") args.userId = argv[index++];
    else if (flag === "--email") args.email = argv[index++];
    else if (flag === "--all") args.all = true;
    else if (flag === "--execute") args.execute = true;
    else if (flag === "--api") args.api = argv[index++] ?? "";
    else if (flag === "--out") args.out = argv[index++];
    else if (flag === "--manifest-hash") args.manifestHash = argv[index++];
    else usage();
  }
  const targets =
    Number(!!args.userId) + Number(!!args.email) + Number(args.all);
  if (
    targets === 0 &&
    (command === "dry-run" || command === "status" || command === "report")
  ) {
    args.all = true;
  } else if (targets !== 1) usage();
  if (
    [
      "retry",
      "restore",
      "preserve-classic",
      "recover-classic",
      "migrate-with-recovery",
    ].includes(command) &&
    args.all
  )
    usage();
  if (command === "recover-classic" && !args.manifestHash) usage();
  if (
    [
      "migrate",
      "migrate-with-recovery",
      "retry",
      "restore",
      "preserve-classic",
      "recover-classic",
    ].includes(command) &&
    !args.execute
  ) {
    console.error(`${command} changes data and requires --execute`);
    process.exit(1);
  }
  args.api = normalizeRetirementApiOrigin(args.api);
  return args;
}

function collectCookies(response: Response): string {
  const values = response.headers.getSetCookie();
  return values
    .map((value) => value.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

async function resolveCookie(api: string): Promise<string> {
  if (process.env.DOTFLOWY_SESSION_COOKIE)
    return process.env.DOTFLOWY_SESSION_COOKIE;
  const email = process.env.DOTFLOWY_ADMIN_EMAIL;
  const password = process.env.DOTFLOWY_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      "Set DOTFLOWY_ADMIN_EMAIL and DOTFLOWY_ADMIN_PASSWORD, or DOTFLOWY_SESSION_COOKIE.",
    );
    process.exit(1);
  }
  const response = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    console.error(
      `admin sign-in failed (${response.status}): ${await response.text()}`,
    );
    process.exit(1);
  }
  const cookie = collectCookies(response);
  if (!cookie) {
    console.error("admin sign-in returned no session cookie");
    process.exit(1);
  }
  return cookie;
}

async function requestJson<A>(
  api: string,
  cookie: string,
  path: string,
  schema: Schema.ConstraintDecoder<A>,
  init?: RequestInit,
): Promise<A> {
  const headers = new Headers({ cookie });
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${api}${path}`, {
    ...init,
    redirect: "error",
    headers,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  // Validate decision fields without removing audit metadata from CLI output.
  const value: unknown = await response.json();
  Schema.decodeUnknownSync(schema)(value);
  // SAFETY: callers use non-transforming schemas; validation proves A while the original value retains audit fields.
  return value as A;
}

function targetBody(args: Args): { userId?: string; email?: string } {
  return args.userId ? { userId: args.userId } : { email: args.email };
}

async function population(api: string, cookie: string): Promise<string[]> {
  const data = await requestJson(
    api,
    cookie,
    "/api/admin/lunora-retirement?population=1",
    Schema.Struct({ userIds: Schema.Array(Schema.String) }),
  );
  return [...data.userIds];
}

async function operate(
  args: Args,
  cookie: string,
  operation:
    | "dry-run"
    | "migrate"
    | "migrate-with-recovery"
    | "retry"
    | "restore"
    | "preserve-classic"
    | "recover-classic",
  target: { userId?: string; email?: string },
): Promise<OperationResult> {
  return requestJson(
    args.api,
    cookie,
    "/api/admin/lunora-retirement",
    OperationResultSchema,
    {
      method: "POST",
      body: JSON.stringify({
        ...target,
        operation,
        approvedManifestHash: args.manifestHash,
      }),
    },
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cookie = await resolveCookie(args.api);
  if (args.command === "status" || args.command === "report") {
    const query = args.all
      ? ""
      : `?${args.userId ? "userId" : "email"}=${encodeURIComponent(args.userId ?? args.email ?? "")}`;
    const report = await requestJson(
      args.api,
      cookie,
      `/api/admin/lunora-retirement${query}`,
      // Reports are printed verbatim; no fields drive migration decisions.
      Schema.Unknown,
    );
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.command === "report" && args.out)
      await Bun.write(args.out, output);
    else process.stdout.write(output);
    return;
  }

  const targets = args.all
    ? (await population(args.api, cookie)).map((userId) => ({ userId }))
    : [targetBody(args)];
  const results: unknown[] = [];
  for (const target of targets) {
    if (
      args.command === "migrate" ||
      args.command === "migrate-with-recovery"
    ) {
      const preview = await operate(args, cookie, "dry-run", target);
      const classification =
        preview.dryRun?.classification ?? preview.classification;
      if (
        preview.state === "completed" ||
        (preview.state === "classified" && classification === "already-classic")
      ) {
        results.push(preview);
        continue;
      }
      if (preview.state === "uncertain" || classification !== "eligible") {
        results.push(preview);
        console.error("Migration batch stopped: operator review required.");
        process.exitCode = 1;
        break;
      }
    }
    const operation = args.command === "dry-run" ? "dry-run" : args.command;
    const result = await operate(args, cookie, operation, target);
    results.push(result);
    if (
      ["migrate", "migrate-with-recovery", "preserve-classic"].includes(
        args.command,
      ) &&
      result.state !== "completed"
    ) {
      console.error(`${args.command} stopped: operation did not complete.`);
      process.exitCode = 1;
      break;
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (import.meta.main) await main();
