---
status: accepted
---

# CLI compatibility with MCP

The CLI design targets both human terminal use and agent scripting, with a
separately installable public package developed in this repository. Its first
release must cover every MCP tool and argument, not just common capture commands.
These requirements were agreed during design and implemented in `cli/`.

The CLI preserves MCP's spoiler redaction for both audiences, including JSON
output, with no reveal flag. This deliberately gives up lossless human exports
to preserve the existing agent boundary: CLI exports are not lossless backups.
See [ADR 0043](./0043-spoilers-redacted-from-agents.md).

The CLI calls the existing MCP endpoint, preserving server validation, limits,
and the paid-plan requirement for tool calls. Friendly commands cover every
current tool. A generic `call` command accepts exact MCP tool names and arguments;
tool discovery exposes server schemas so new tools remain callable without a CLI
release. No duplicate outline API or local mutation implementation is introduced.

Human output prints MCP text content. JSON output preserves the MCP result object
instead of parsing prose into invented structured records. Search now includes
server-defined structured nodes and continuation, with CLI-only `--all`
aggregation ([ADR 0063](./0063-dql-search-parity.md)).

Deletion requires `--yes`, including through `call delete_node`; scripts never
wait for a confirmation prompt. Other writes execute immediately. OPML import
retains its existing dry-run support. The CLI never automatically retries a write
whose outcome is unknown.

Friendly daily commands default to the machine's timezone and offer an explicit
override. Raw `call` preserves arguments exactly, including MCP's UTC default when
neither a date nor timezone is supplied.

Distribution targets an npm package exposing `dotflowy`, supporting Node.js 22+
on macOS, Linux, and Windows. Development and tests use Bun; users do not need it.
Standalone binaries and Homebrew are deferred. The npm name `dotflowy` was
available when checked, but has not been reserved or published.

Login uses browser-based OAuth authorization code with PKCE and a temporary
loopback callback listener, validates state, and times out abandoned attempts.
The CLI never asks for the user's Dotflowy password. Automation can supply an
existing OAuth bearer through `DOTFLOWY_TOKEN`, never a command-line token flag;
environment-provided credentials stay in memory. No new API-key system is added.

Configuration supports one saved account per server URL, defaults to hosted
Dotflowy, and allows a server override for self-hosting and local development.
Credentials are isolated by server. HTTP is allowed only for loopback development.
Signing in again replaces that server's saved account; named profiles for multiple
accounts on the same server are deferred.

Saved credentials use the operating system's credential store: Keychain on macOS,
Credential Manager on Windows, and a Secret Service-compatible keyring on Linux.
If secure storage is unavailable, the CLI explains the failure rather than
automatically writing plaintext. Users can supply an environment token or explicitly
choose `login --insecure-storage` to use an unencrypted, user-only credential file.
Diagnostics never print credentials. OS credential storage reduces accidental
exposure; it does not guarantee protection from malware running as the user.

Logout removes local credentials only. The current OAuth provider has no MCP
revocation endpoint, so the CLI does not claim to revoke server tokens.
