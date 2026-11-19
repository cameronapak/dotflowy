import { Schema } from "effect";
import { readFile } from "node:fs/promises";

import { ReconnectNoticeBody } from "../worker/reconnect-notice";
import { resolveAdminCookie } from "./admin-session";

export function parseRecipientCsv(csv: string): string[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let closed = false;
  const source = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else value += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(value);
      value = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && source[i + 1] === "\n") i++;
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
      }
    } else if (c === '"' && value === "" && !closed) quoted = true;
    else if (closed || c === '"') throw new Error("Invalid CSV quoting.");
    else value += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  const headers = rows.shift()?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const column = headers.indexOf("email");
  if (column < 0 || headers.lastIndexOf("email") !== column)
    throw new Error("CSV needs one email column.");
  const recipients = rows.map((cells) => {
    if (cells.length !== headers.length)
      throw new Error("CSV row width does not match header.");
    return cells[column]!.trim().toLowerCase();
  });
  const decoded = Schema.decodeUnknownSync(ReconnectNoticeBody)({
    recipients,
    dryRun: true,
  });
  return [...new Set(decoded.recipients)];
}

export function reconnectArgs(argv: string[]) {
  let api = process.env.DOTFLOWY_API ?? "https://app.dotflowy.com";
  let csv: string | undefined;
  let send = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--send") send = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--api") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error("--api needs a URL.");
      api = next;
    } else if (arg.startsWith("--") || csv)
      throw new Error("Unexpected argument.");
    else csv = arg;
  }
  if (!csv || (send && dryRun))
    throw new Error(
      "Pass a CSV path and either --dry-run (default) or --send.",
    );
  const url = new URL(api);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("API must be an origin URL.");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("API must use HTTPS except on loopback.");
  return { api: url.origin, csv, dryRun: !send };
}

export function maskRecipient(email: string): string {
  const [local, domain = ""] = email.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain.slice(0, 1)}***`;
}

const NoticeResponse = Schema.Struct({
  dryRun: Schema.Boolean,
  results: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      status: Schema.Literals(["accepted", "failed", "simulated"]),
    }),
  ),
  message: Schema.optional(
    Schema.Struct({
      subject: Schema.String,
      text: Schema.String,
      html: Schema.String,
    }),
  ),
});

async function main() {
  const args = reconnectArgs(process.argv.slice(2));
  const recipients = parseRecipientCsv(await readFile(args.csv, "utf8"));
  const token = process.env.DOTFLOWY_RECONNECT_TOKEN;
  if (token !== undefined && (token.length < 32 || /\s/.test(token)))
    throw new Error("Invalid reconnect token.");
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  else headers.set("cookie", await resolveAdminCookie(args.api));
  const response = await fetch(`${args.api}/api/admin/reconnect-notice`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipients, dryRun: args.dryRun }),
  });
  if (!response.ok) throw new Error("Reconnect notice request failed.");
  const result = Schema.decodeUnknownSync(NoticeResponse)(
    await response.json(),
  );
  if (
    result.dryRun !== args.dryRun ||
    result.results.length !== recipients.length ||
    result.results.some((entry, index) => entry.email !== recipients[index])
  )
    throw new Error("Unexpected response.");
  console.log(
    result.dryRun
      ? "DRY RUN: no emails sent."
      : "Send results (acceptance is not inbox delivery):",
  );
  for (const [index, entry] of result.results.entries())
    console.log(`${index + 1}. ${maskRecipient(entry.email)}: ${entry.status}`);
  if (result.message) console.log(JSON.stringify(result.message, null, 2));
  if (
    !args.dryRun &&
    result.results.some((entry) => entry.status !== "accepted")
  )
    process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(() => {
    console.error(
      "Reconnect notice failed. Check arguments, CSV, admin authentication, and server status. No automatic retry; inspect outcomes before resending.",
    );
    process.exitCode = 1;
  });
}
