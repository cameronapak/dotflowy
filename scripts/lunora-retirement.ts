/**
 * Temporary ADR 0061 operator CLI. Dry-run is the default and every mutating
 * command requires --execute. Batches are deliberately sequential.
 */

type Command =
  | "dry-run"
  | "migrate"
  | "retry"
  | "status"
  | "restore"
  | "report";

interface Args {
  command: Command;
  api: string;
  userId?: string;
  email?: string;
  all: boolean;
  execute: boolean;
  out?: string;
}

function usage(): never {
  console.error(`Usage:
  bun run lunora:retire [dry-run] (--user ID | --email EMAIL | --all)
  bun run lunora:retire migrate (--user ID | --email EMAIL | --all) --execute
  bun run lunora:retire retry (--user ID | --email EMAIL) --execute
  bun run lunora:retire status [--user ID | --email EMAIL | --all]
  bun run lunora:retire restore (--user ID | --email EMAIL) --execute
  bun run lunora:retire report [--user ID | --email EMAIL | --all] [--out FILE]

Options: --api URL (default DOTFLOWY_API or https://app.dotflowy.com)`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const commands = new Set<Command>([
    "dry-run",
    "migrate",
    "retry",
    "status",
    "restore",
    "report",
  ]);
  let command: Command = "dry-run";
  let index = 0;
  if (commands.has(argv[0] as Command)) {
    command = argv[0] as Command;
    index++;
  }
  const args: Args = {
    command,
    api: (process.env.DOTFLOWY_API ?? "https://app.dotflowy.com").replace(
      /\/$/,
      "",
    ),
    all: false,
    execute: false,
  };
  while (index < argv.length) {
    const flag = argv[index++];
    if (flag === "--user") args.userId = argv[index++];
    else if (flag === "--email") args.email = argv[index++];
    else if (flag === "--all") args.all = true;
    else if (flag === "--execute") args.execute = true;
    else if (flag === "--api")
      args.api = (argv[index++] ?? "").replace(/\/$/, "");
    else if (flag === "--out") args.out = argv[index++];
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
  if ((command === "retry" || command === "restore") && args.all) usage();
  if (["migrate", "retry", "restore"].includes(command) && !args.execute) {
    console.error(`${command} changes data and requires --execute`);
    process.exit(1);
  }
  return args;
}

function collectCookies(response: Response): string {
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(
          (value): value is string => value !== null,
        );
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

async function requestJson(
  api: string,
  cookie: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      cookie,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

function targetBody(args: Args): { userId?: string; email?: string } {
  return args.userId ? { userId: args.userId } : { email: args.email };
}

async function population(api: string, cookie: string): Promise<string[]> {
  const data = (await requestJson(
    api,
    cookie,
    "/api/admin/lunora-retirement?population=1",
  )) as { userIds: string[] };
  return data.userIds;
}

async function operate(
  args: Args,
  cookie: string,
  operation: "dry-run" | "migrate" | "retry" | "restore",
  target: { userId?: string; email?: string },
): Promise<unknown> {
  return requestJson(args.api, cookie, "/api/admin/lunora-retirement", {
    method: "POST",
    body: JSON.stringify({ ...target, operation }),
  });
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
    if (args.command === "migrate") {
      const preview = (await operate(args, cookie, "dry-run", target)) as {
        classification?: string;
        dryRun?: { classification?: string };
      };
      if (
        (preview.dryRun?.classification ?? preview.classification) !==
        "eligible"
      ) {
        results.push(preview);
        continue;
      }
    }
    const operation = args.command === "dry-run" ? "dry-run" : args.command;
    results.push(await operate(args, cookie, operation, target));
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();
