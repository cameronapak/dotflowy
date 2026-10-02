# Dotflowy CLI

Use Dotflowy from your terminal or an agent script. The CLI calls the same MCP
endpoint as an agent connector, including its paid-plan requirement and limits.
It supports all 12 current tools and can discover and call future server tools.

## Install

Use Node.js 22.19.0 or newer. Bun is used for development, not required to run
the installed executable.

```sh
npm install --global dotflowy
dotflowy --help
```

### Install from this checkout

From the repository root:

```sh
bun install --cwd cli
bun run build:cli
node cli/dist/main.js --help
```

To install a local build, run `npm pack` inside `cli/`, then pass the tarball
path that it prints to `npm install --global`.

## Sign in

```sh
dotflowy login
dotflowy status
```

Login opens your browser and uses OAuth with PKCE. The callback listener binds
only to `127.0.0.1`, chooses an available port, and closes after login or a
five-minute timeout. You never enter your Dotflowy password in the terminal.
Use `--no-browser` to open the printed URL yourself, in a browser on the same
machine. A remote shell requires loopback port forwarding or an environment token;
opening its login link on a different machine alone does not complete login.

Saved credentials use macOS Keychain, Windows Credential Manager, or Linux
Secret Service. Linux requires an available, unlocked keyring and D-Bus session.
Missing native bindings or a locked/unavailable keyring cause an error, never an
automatic plaintext fallback.

If you deliberately accept unencrypted storage, use
`dotflowy login --insecure-storage`. Files are user-only: a private directory and
0600 files on Unix, or a current-user-only directory ACL on Windows. Do not point
`DOTFLOWY_CONFIG_DIR` at a shared directory; the CLI restricts that directory's
permissions. OS credential storage reduces accidental exposure, not malware
running as you.

Switching to file storage saves the replacement before removing the old keyring
entry. If the keyring is unavailable, login succeeds with a warning and records
pending cleanup. Unlock the keyring and run `logout` to remove both. Until then,
logout fails rather than claiming that all saved credentials were removed.

For automation, inject an existing OAuth bearer as `DOTFLOWY_TOKEN` through your
secret manager. Do not put it in command arguments or shell history. Environment
tokens override saved credentials and are never persisted or refreshed by the
CLI. Saved OAuth credentials refresh automatically before expiry.

`dotflowy logout` deletes the selected server's local credentials. **It does not
revoke server tokens or change environment variables.** The current auth provider
does not expose an MCP token-revocation endpoint.

Credential refresh, login replacement, and logout share a per-server process
lock. A waiting operation fails after about 30 seconds rather than taking over
another process's lock. If a process is forcibly terminated, stop all Dotflowy
processes before removing the `.json.lock` directory named in the error. Normal
completion, errors, and handled interruption release the lock automatically.
Browser authorization does not hold the lock.

## Commands

| CLI                               | MCP tool          |
| --------------------------------- | ----------------- |
| `outline [NODE_ID]`               | `get_outline`     |
| `search "query"`                  | `search_nodes`    |
| `add "text"`                      | `add_node`        |
| `subtree --input forest.json`     | `add_subtree`     |
| `update NODE_ID`                  | `update_node`     |
| `delete NODE_ID --yes`            | `delete_node`     |
| `move NODE_ID...`                 | `move_nodes`      |
| `today "text"`                    | `add_to_today`    |
| `mirror NODE_ID`                  | `mirror_node`     |
| `mirror-today NODE_ID`            | `mirror_to_today` |
| `import-opml --file outline.opml` | `import_opml`     |
| `export-opml [NODE_ID]`           | `export_opml`     |

Run `dotflowy COMMAND --help` for flags. `dotflowy tools` lists the server's
tools; `dotflowy tools TOOL_NAME` prints its description and complete input schema.

```sh
dotflowy today "Follow up with Alex" --task --time-zone America/Chicago
dotflowy add "Project notes" --parent NODE_ID --kind paragraph
dotflowy update NODE_ID --completed
dotflowy update NODE_ID --no-completed --text "Revised text"
dotflowy move FIRST_ID SECOND_ID --parent DESTINATION_ID --position first
dotflowy import-opml --file outline.opml --parent NODE_ID --dry-run
dotflowy export-opml NODE_ID > outline.opml
dotflowy call get_outline --args '{"nodeId":null,"maxDepth":2}' --json
```

Every tool command also accepts `--input FILE` or `--args JSON` containing its
exact MCP argument object. Use `--input -` for stdin. Nested subtree input looks
like `{"nodes":[{"text":"Parent","children":[{"text":"Child"}]}]}`.
Use `call TOOL_NAME` for a tool added after this CLI version. Explicit `null`,
`false`, empty strings, arrays, and nested objects are preserved in raw calls.
Do not supply the same field in both JSON input and command flags.

For multiline text, use `add`, `today`, or `update` with `--text-file FILE|-`.
OPML import accepts `--file FILE|-`. Only one input can consume stdin per command.
Text and OPML file inputs preserve their trailing newline.

Friendly `today` and `mirror-today` commands default to the machine's timezone;
use `--time-zone` on remote machines or `--date YYYY-MM-DD` for an explicit day.
Raw `call` never inserts defaults: an omitted date/timezone retains MCP's UTC
behavior. Subtree and OPML daily targeting require an explicit `date`.

## Safety and output

- Deletion includes the entire subtree and requires `--yes`, including through
  `call delete_node`. Newly discovered tools marked destructive also require it.
- Other writes execute immediately. Import supports the server's `dryRun` option.
- Requests time out after 30 seconds and are not automatically retried. If a write
  times out or the connection fails, it may already have committed. Inspect your
  outline before retrying; a second create can duplicate nodes.
- **Spoilers remain redacted in every output format. Exports are not lossless
  backups.** Use the app for a full-fidelity human export.
- **Do not read-modify-write spoiler-bearing text.** Writing `[spoiler]` back as
  replacement text destroys the hidden content. Supply the intended full text
  yourself, or update only non-text fields.
- Human output strips terminal control characters. `--json` preserves the MCP
  result object, including content blocks and any future structured fields. It
  does not manufacture structured node records from text receipts.
- Successful results go to stdout; diagnostics go to stderr. In JSON mode, tool
  refusals remain intact on stdout with a nonzero exit code. Transport, protocol,
  and usage errors emit a JSON error on stderr. Built-in help/version/completion
  output is plain text even with `--json`.

| Exit code | Meaning                                                |
| --------- | ------------------------------------------------------ |
| 0         | Success                                                |
| 1         | Transport, protocol, configuration, or storage failure |
| 2         | Invalid command usage or missing deletion confirmation |
| 3         | Missing or invalid authentication                      |
| 4         | MCP tool refusal (`isError`)                           |
| 5         | Paid plan required                                     |
| 130       | Interrupted                                            |

The server currently caps outline reads at 500 nodes, search at 25 matches,
subtree creation at 500 nodes, and OPML operations at 5,000 nodes. The CLI does
not bypass these caps. Read smaller subtrees when an outline result is truncated.

## Configuration

`--server ORIGIN` overrides `DOTFLOWY_SERVER`; the default is
`https://app.dotflowy.com`. Use an origin, not a URL ending in `/mcp`.
Only HTTPS is accepted except for loopback HTTP development. Requests do not
follow redirects, and OAuth endpoints must belong to the selected server.

There is one saved account per server. Signing in again replaces that server's
saved account. Server selection is explicit per invocation or environment; it
does not silently switch your default after login.

`DOTFLOWY_CONFIG_DIR` overrides the configuration directory. Otherwise it is
`$XDG_CONFIG_HOME/dotflowy` (default `~/.config/dotflowy`) on Unix, or
`%APPDATA%\dotflowy` on Windows. Keyring-backed metadata files contain no tokens.

## Development and verification

From the repository root:

```sh
bun install --cwd cli
bun run build:cli
bun run typecheck:cli
bun run test:cli
```

Tests exercise the Node executable against loopback HTTP fixtures. The opt-in
live test requires the local Worker, `bun run seed:user`, and
`bun run comp:dev-plan`. Configure local OAuth as described in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#testing-the-mcp-oauth-flow-locally), then run:

```sh
DOTFLOWY_LIVE_TEST=1 bun run test:cli
```

The live test targets only the seeded account on `http://localhost:8787`. It
checks login, refresh, every tool, redaction, and logout, then deletes its test
nodes. Creating a daily note can leave that day's calendar scaffolding.

The Effect packages are pinned together, including `platform-node-shared`, to
avoid mixing incompatible prerelease APIs. Update them as a set. The native
keyring dependency is optional at install time so headless token-based use still
works on machines without a supported binding; secure login never downgrades.
