# Security model — Dotflowy

What this system protects, who can reach it, and which attackers count. Security scans and reviewers use it to judge findings. Facts marked **(owner)** come from the repo owner; the rest is drawn from the code.

## Components

| Component           | Code                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Dotflowy Worker     | `worker/` (Better Auth, MCP + MCP OAuth, capture keys, invites, Stripe, backup/restore, unfurl), `wrangler.jsonc`, `migrations/` |
| Dotflowy Web Client | `src/` (TanStack Start, local-first sync, plugins), `landing/`                                                                   |
| Dotflowy CLI        | `cli/` (credentials, MCP client)                                                                                                 |

## Trust boundaries and entry points

internet → Worker. Email/password sign-up (Better Auth, captcha; `SIGNUP_OPEN=true` in `wrangler.jsonc`, plus per-email and shared invite codes). Each user's outline lives in a per-user Durable Object routed by `user.id`; cross-user access to another user's DO is the core boundary. MCP endpoint + MCP OAuth and capture API keys give outside agents access to an outline. Stripe webhooks. URL unfurl/embeds fetch attacker-supplied URLs (SSRF surface).

## Assets

All assets matter equally **(owner)**.

- Users' private outlines and notes.
- Stripe billing state.
- Deploy credentials and CI secrets.

## Attackers that matter

Every attacker below matters **(owner)**.

- Anonymous internet user.
- Signed-up user attacking other users' outlines (sign-up is public).
- Malicious URLs submitted for unfurl or embeds.
- Outside agents holding MCP/OAuth tokens or capture keys with limited scope.

## Existing controls

Better Auth sessions, captcha, invite gate; per-user Durable Object routing by `user.id`; SSRF guard in `worker/unfurl.ts`.

## Out of scope / accepted risk

Nothing is out of scope; demo, prototype and tooling code count too **(owner)**.
