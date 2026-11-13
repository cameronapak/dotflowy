---
status: accepted
---

# Scoped, expiring API keys

Cam approved API-key authentication alongside OAuth for CLI automation, a unified management surface, server-enforced read-only access, and mandatory expiration. This amends [MCP authentication](./0026-agent-native-mcp-server.md), [CLI compatibility](./0061-cli-mcp-compatibility.md), and [external Quick-add](./0065-external-quick-add-with-capture-keys.md).

## Permissions and lifecycle

Settings → Connections → API keys manages every personal key. Three immutable permission presets keep grants understandable: Capture only appends to caller-specified daily notes through `/api/capture`; Read-only permits MCP outline reads, search, and export; Read and write permits all MCP tools and capture. A key cannot authenticate browser APIs or mint another key. Broader access requires a new key, never an in-place upgrade. Apple Shortcut setup creates Capture only keys through the same management API.

New keys default to 30 elapsed days and may instead last 90 days. Neither the UI nor server accepts indefinite or annual lifetimes. Migration 0015 caps existing lifetimes at 90 days from migration execution, preserving earlier expirations, hashes, and capture-only access. Cam explicitly approved this grace period after read-only production inspection. The UI shows each key's permission, expiration date, expired state, and replacement instructions. There is no automatic renewal. Existing users must replace their credential in each installed shortcut or script; installing an updated public template does not update a personal copy.

Rotation is an explicit replacement, not a permission change or automatic renewal. A session-authenticated `PATCH /api/keys` replaces the secret and starts a new 30- or 90-day lifetime, preserving the key's id, name, and permission. The old secret stops working immediately. The UI warns before rotation, reveals the replacement once, and blocks closing while issuance is in flight. Users must update every connection using the old secret. Expired keys may also rotate. Lost responses require another rotation; secrets cannot be recovered.

The existing daily 09:00 UTC cron sends an expiration reminder when a live, verified owner's key has at most seven days remaining. Migration 0016 records delivery per expiration and adds a bounded, token-fenced claim so concurrent sweeps do not normally duplicate a send. Failed sends release the claim; interrupted sends can retry after five minutes. Rotation gives the new expiration its own reminder eligibility. Messages contain the key's name, permission, expiration, and a canonical Settings link, never a secret. Revoked, expired, deleted-owner, unverified-email, and password-invalidated keys are excluded. Missing email configuration skips without marking delivery. Provider acceptance followed by interruption before the database stamp can still cause a duplicate; the email binding has no idempotency guarantee. Reminder work runs on `ctx.waitUntil`, independently of the awaited backup sweep.

The existing `capture_key` table remains the one store, with an added permission column defaulting to capture. Existing `dfc_` secrets remain valid; newly issued secrets use `dfk_`. Secrets contain 256 random bits, are revealed once, and are stored only as SHA-256 digests. Authentication reads live identity, permission, expiration, and password version on every request. Revocation, account deletion, and password change/reset invalidate keys; sign-out does not. Management stays cookie-session authenticated with origin checks and a fresh-session requirement for creation. `/api/keys` is canonical; `/api/capture-keys` is a compatibility alias whose creation contract remains capture-only.

## MCP and CLI

API keys and OAuth use the same MCP handler, per-user Durable Object routing through `resolveUserId`, paid-plan gate, node limits, and spoiler redaction. Read-only discovery publishes only the registry's read-only tools. The dispatcher independently rejects direct calls to write tools before validation or execution, including import, mirror, move, and daily-note operations. New tools must declare their read-only status in the registry; metadata is server-owned, not a client assertion.

The CLI already passes `DOTFLOWY_TOKEN` as a bearer. It now documents personal API keys and gives replacement guidance on failed authentication. Environment credentials are not saved or refreshed. Browser OAuth login and automatic refresh of saved OAuth credentials remain unchanged. No parallel outline REST API or duplicate mutation implementation is introduced.

## Shortcut discovery, failures, and icon

External Quick-add is no longer experimental. Apple Shortcut and API keys appear directly under Connections; the per-device discovery flag is removed. Cam reports successful use; this does not turn untested device paths into verified ones.

Invalid or expired capture credentials return 401 before any outline mutation. Both the server message and the updated Shortcut failure branch explicitly direct the user to **Dotflowy Settings → Connections → API keys** and tell them to replace the key in the installed shortcut's Text action. Failure is never presented as a successful save.

The Cherri source uses a neutral circular glyph inspired by Dotflowy's dot logo. Apple's documented shortcut collection customization supports built-in glyphs and colors; exact custom images are a separate Home Screen choice. Setup links to the existing Dotflowy PNG for that purpose rather than relying on undocumented icon-image plist metadata.

Changing Cherri source requires rebuilding the private unsigned input and signing a new public template with Apple's CLI before release. The unsigned build never overwrites the public signed file. An iCloud-signed-in Mac is required. Native import, icon rendering, and expired-key behavior on a real iPhone remain device checks, not claims inferred from compilation or browser tests.
