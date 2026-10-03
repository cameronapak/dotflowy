---
status: accepted
---

# External Quick-add with scoped capture keys

An official Apple Shortcut extends [Quick-add](./0049-quick-add-capture-surface.md)
outside the editor without a native mobile app. Cam approved capture on every
plan, using a named, revocable capture key that permits adding to daily notes
but cannot read, edit, or delete existing outline content. Cam approved the
complete design and local implementation. Cam reports successful Mac signing
and import. End-to-end real-device testing remains a general-release requirement.

## Settled decisions

- **No paid-plan gate.** Capture uses the normal account node limit, including
  any calendar scaffolding needed for a new day. Any script holding the key can
  perform the same limited operation; the credential does not prove human use.
- **Paste-once setup.** You sign in to Dotflowy, create a named key, and paste it
  into the official shortcut's setup prompt. The public template contains no
  personal credential. The secret is revealed once, stored only as a hash on the
  server, and sent in an authorization header, never in a URL. Sharing your
  configured shortcut can expose the key.
- **Separate keys from installation.** Capture keys are an account capability
  for shortcuts and scripts. Settings has a Capture keys row with Manage, and
  a separate Apple Shortcut row with Set up. During the experiment, both live
  under Experimental. Header More has Add Apple Shortcut,
  which opens the same focused setup dialog as Settings. The dialog creates a
  named key (default iPhone), offers automatic and manual copying, and then
  links to the official template. A small Settings link leads to key management;
  the installer does not list or revoke keys.
- **Use an iCloud installation link.** Prefer a verified, public,
  credential-free iCloud sharing link over a file download. A link click is not
  proof of installation. Verify Safari and Home Screen PWA handoff on a real
  iPhone, including a copy-link fallback for opening in Safari. Cam supplied
  an iCloud link after signing/importing; use it only in the opt-in experiment
  until its clean contents and real-device workflow are verified. Do not offer
  the unsigned artifact as installable.
- **Experimental rollout.** Settings → Experimental → External quick-add is a
  default-off, per-device flag. Opting in reveals both separate Settings rows
  and the header More installer. Keep the untested status visible. The flag is
  a discovery gate, not API authorization or a server kill switch; disabling
  it does not revoke keys or stop already installed shortcuts. All plans can
  opt in. Remove the temporary gate after real-device verification.
- **One capture, one bullet.** Accept shared text or a URL. Without shared input,
  prompt for text, with keyboard dictation available. Flatten multiline text to
  spaces, matching the single-node Quick-add surface. Blank input or cancellation
  creates nothing, including no daily-note scaffold. Append at the bottom; no
  task chooser, attachment conversion, or structural import in the first version.
- **Device-local Today.** Use the phone's local date at submission, not its date
  when composition began or a saved home timezone. Keep that date unchanged
  throughout retries. No date picker or silent UTC fallback. The endpoint permits
  append-only capture to a caller-specified daily note; the official shortcut
  always chooses Today. The credential does not enforce the current date on the
  server and cannot target arbitrary outline nodes.
- **Save links before fetching titles.** For a standalone shared URL, preserve
  a supplied title; otherwise save a clickable URL-labelled Markdown link and
  acknowledge the capture before fetching its title in the background. Reuse the
  guarded [title-unfurl logic](./0016-link-title-unfurl.md). Upgrade an untouched
  placeholder label only; never overwrite subsequent edits or a supplied title.
  If lookup fails, keep the working link without reporting a failed capture. Do
  not rewrite links embedded in authored thoughts.
- **Online-only initially.** Confirm success only after a committed-save
  acknowledgment. A timeout can mean the node was saved: report that the outcome
  could not be confirmed, rather than claiming it was not saved. Retries of the
  same attempt are idempotent; a fresh invocation is a new capture, even if its
  text is identical. No persistent offline queue initially.
- **Key lifecycle.** Keys survive ordinary sign-out. Support individual and
  all-key revocation. Invalidate them on successful password reset/change and
  account deletion. At creation, offer No expiration (default), 30 days, 90 days,
  and 1 year. Show expiration afterward. An expired key produces a clear
  instruction to create a replacement and update the shortcut.
- **Official distribution.** Deliver an installable, credential-free template,
  not only assembly instructions. Verify installation, sharing, direct launch,
  and failure behavior on a real iPhone before release. Watch and hands-free
  Siri guarantees are outside the initial scope.

## Boundary and reuse

This is a narrow credential exception to [MCP's OAuth decision](./0026-agent-native-mcp-server.md),
not a general REST API or an alternate credential for MCP or the
[CLI](./0061-cli-mcp-compatibility.md). Keep the existing Better Auth identity:
keys belong to `user.id`, and outline routing uses `resolveUserId`, including the
owner-continuity bridge. Key management remains session-authenticated. Captures
use `origin: null`; the key does not establish that an AI agent authored the node.

Reuse the shared daily-note planners and classic outline store, not the MCP
handler's paid gate, transport, or prose receipts. Enforce the node limit at
commit time, preserve the sibling chain under concurrent captures, and record
the attempt receipt atomically with its node writes. An atomic batch alone does
not prevent duplicate captures or stale-snapshot append conflicts. Replay must
not recreate a subsequently deleted node or overwrite later edits.

Follow the existing [input-validation boundary](./0014-validate-the-worker-do-trust-boundary.md),
[auth gate](./0011-the-auth-gate.md), and [account-deletion lifecycle](./0051-self-serve-account-deletion.md).
Bound input sizes and abuse rates. Deleted identities must fail authorization
even if best-effort credential-row cleanup fails. Do not log key secrets or
captured text.

## Release verification

Shortcuts installation, HTTP failure handling, date formatting, and the full
real-device workflow have not been demonstrated yet. These are feasibility and
release checks, not claims about completed behavior.
