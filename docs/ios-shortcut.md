# Dotflowy Apple Shortcut

The official template is the signed [`Dotflowy.shortcut`](../public/shortcuts/Dotflowy.shortcut), distributed at `https://app.dotflowy.com/shortcuts/Dotflowy.shortcut`. It accepts text or a URL from the share sheet and enables Spotlight visibility and input. When launched directly, it asks “What do you want to add to today?”; the standard keyboard dictation button works in that text field. Cancelling or submitting only whitespace sends nothing.

## Release state

The local generated file is now an **Apple-signed AEA1 artifact**. Its unsigned
workflow was compiled from
[`shortcuts/add-to-dotflowy-today.cherri`](../shortcuts/add-to-dotflowy-today.cherri)
with [Cherri](https://cherrilang.org) v2.3.0 using `--skip-sign`, validated, and
then signed with Apple's `shortcuts sign --mode anyone`. Cam approved deploying
the opt-in experiment on 2026-10-04. Its initial manual deployment used app
release `1.19.2`, including PR #389. The generated unsigned input and signed
public file are retained together in Git, so deployments from `main` preserve
the install download without requiring Apple signing on the Linux release
runner. A source change still requires a new build and Mac signing before merge.
The template this replaced was hand-written plist data and shipped two actions
Shortcuts does not know:
`is.workflow.actions.matchtext` (macOS rendered “Unknown Action” there) and
`is.workflow.actions.generateuuid`, which is not a built-in action at all. The
template now uses `is.workflow.actions.text.match` and two bounded random numbers
for its attempt ID.

The deployed installer points directly to the signed file on `app.dotflowy.com`.
No short URL, Dub destination, or iCloud sharing link is required for official
distribution. Cam reports successful file
import and capture, but the imported name was `add-to-dotflowy-today` and the icon
was a calculator. The public filename is now `Dotflowy.shortcut`. A fresh import
of the final signed file on the Mac showed the name **Dotflowy**, the light-blue
list glyph, and one capture-key setup question. The installed Mac library tile
also showed the list glyph. Its import preview exposed Share Sheet and Receive
Input from Spotlight. Actual Spotlight input and fresh iPhone name/icon behavior
remain unverified. The existing personal copy was not changed. Do not infer the
old icon's cause from the screenshot alone or claim an iPhone result from a Mac
import.
The one-question workflow passed macOS runtime checks in a separate dummy-key
copy against a loopback endpoint. After the Cherri refactor, all 13 runtime
cases passed: shared text, URLs, and direct-launch text produced one schema-valid
capture with the Mac-local date; shared whitespace, prompt whitespace, and
cancellation sent nothing; false `saved`, each missing receipt field, a malformed
receipt date, invalid-key, and server-error responses selected the failure branch.
Success and server-error messages matched their expected text. The test
copy replaced notification/result actions with trace requests to assert their
branches and error text. It removed import questions for runtime testing, so
these checks do not establish setup-answer persistence or sharing behavior.
All 17 template unit tests, including the Mac-only pre-sign credential rejection
test, all 1,099 app/Worker unit tests, all three typechecks, and all six
capture-key/setup browser tests passed after the rebase. The web build preserved
the signed bytes and excluded the private unsigned input. An isolated local
Cloudflare asset test passed with Node: signed bytes, download filename/MIME
headers, cache revalidation, and ETag. That harness stalled under Bun; it was
stopped and rerun under Node. The live download returned HTTP 200 and matched the
local signed file byte-for-byte, with the expected filename/MIME, cache
revalidation, and ETag headers. The deployed installer was visually checked at
phone width using mocked account/data APIs, without production writes. Finder
metadata is excluded through `public/.assetsignore`; live requests for it and
the private unsigned file returned the HTML fallback, not those files.
Safari and Home Screen PWA handoff, setup-answer persistence on a fresh import,
and the full iPhone
share-sheet and failure-case checks remain unverified. Keep External quick-add
default-off until those checks pass.

The local template now asks only for a Dotflowy capture key. The repository
contains only the placeholder `PASTE_CAPTURE_KEY_DURING_IMPORT`, never a working
credential. Rebuild, validate, sign, and publish the clean file at the same URL
for each release. New downloads receive the updated file; already-installed
shortcuts do not update automatically.

The request uses `https://app.dotflowy.com/api/capture` without a setup question.
If you self-host, edit the URL in **Get Contents of URL** to your capture endpoint
before using your key.

Sign-in, account selection, and capture-key revocation remain web tasks.

## Setup surfaces

In **Settings → Experimental**, turn on **External quick-add**. This temporary
flag defaults off and persists per browser/device as
`dotflowy:flag:external-capture` (`on` or `off`). It controls discovery, not API
authorization. Turning it off hides setup without revoking existing keys.

**Experimental → Capture keys → Manage** creates and revokes keys for any
shortcut or script. It does not contain installation instructions.

**Experimental → Apple Shortcut → Set up** and **More → Add Apple Shortcut** open
the same focused setup dialog. You create a key named **iPhone** by default,
choose its expiration, and copy it. If automatic copying fails, select the
read-only key field and use your device's **Copy** command. Closing the dialog
clears the revealed secret. The Settings link leads back to key management.

**Add to Apple Shortcuts** opens the signed `Dotflowy.shortcut` file directly,
without including a key. If the browser downloads it, open it from Files.
**Copy installation link** provides a Safari fallback for Home Screen PWA
handoff. If automatic copying fails, a selectable link field appears. The
unsigned artifact is not offered as an install download. Opening or downloading
the file does not confirm installation.

## Credential storage and sharing

Your installed shortcut contains the capture key in a readable Text action, not
an isolated Keychain item. Treat it as a credential. Keep the key solely in the
Text field bound to the import question; the authorization header references
that action's output rather than holding another literal copy of the key.

[Apple documents that sharing clears fields bound to import questions](https://support.apple.com/guide/shortcuts/add-import-questions-to-shared-shortcuts-apdf330fd3a0/ios).
This helps prevent accidental disclosure through Apple's sharing mechanism, but
does not hide the key in your installed copy. Clearing has not been verified for
our published shortcut. Do not assume raw exports or external signing tools
clear credentials, and do not describe the shortcut as safe to share until the
relevant sharing path passes the dummy-key check below.

## Keep the published template separate from personal copies

Publish only the generated, signed template with its capture-key placeholder.
Never export a configured personal copy for official distribution. If you keep
a clean master in the Shortcuts app, name it **Dotflowy**, leave its key field as
`PASTE_CAPTURE_KEY_DURING_IMPORT`, and duplicate it for personal use.

The source of truth is `shortcuts/add-to-dotflowy-today.cherri`;
`shortcuts/Dotflowy.unsigned.shortcut` is its generated build input, and
`public/shortcuts/Dotflowy.shortcut` is its signed public download.
`scripts/shortcut.ts` compiles it and normalizes the capture-key import question (Cherri
v2.3.0 writes import questions without a usable `ActionIndex` and leaves their parameters
empty, which is what made a shared copy fail with “Please choose a value for each
parameter in this action”). It also assigns distinct conditional grouping IDs
and remaps conditional-output references to their closing actions. It decodes
XML newline entities so receipt variable offsets stay correct. Immutable
conditional outputs for input selection and receipt status replace mutable
variables, reducing the generated workflow from 40 actions to 37.
A signed export of the clean master can be retained
with the release, but never commit or upload a personalized shortcut containing
a working key.

Set the name, glyph, and color in the Cherri source, then rebuild and sign.
Cherri's name directive controls its output filename; Shortcuts can use the
downloaded filename as the imported name. Keep both the public basename and the
download header's filename as `Dotflowy.shortcut`.
In a personal copy, tap the icon beside its name in the shortcut editor to
choose a glyph and color. A custom image is a separate **Add to Home Screen**
option, not the shortcut collection's glyph.

## Behavior and protocol

The Cherri directives for Share Sheet, Show in Spotlight, and Accepts Input from
Spotlight are:

```cherri
#define from sharesheet, search, spotlight
#define inputs text, url
```

`search` enables visibility; `spotlight` enables input through `ShortcutInput`.
The existing input-selection branch uses that input or prompts when none arrives.
Apple introduced the Spotlight controls in OS 26; test Spotlight input on a
supported Mac separately from iPhone share-sheet behavior.

Each nonblank invocation creates a UUID-shaped attempt ID by joining two six-digit outputs from the built-in Random Number action. This avoids Shortcuts' signed 32-bit limit, which clamps a single 12-digit random number to `2147483647` and produces an invalid attempt ID. The shortcut formats the phone's current local date as `yyyy-MM-dd` immediately before submission. It sends:

```http
POST /api/capture
Authorization: Bearer <capture key>
Content-Type: application/json

{"attemptId":"<UUID>","date":"yyyy-MM-dd","text":"<input>"}
```

The optional `title` field is intentionally omitted by this stock template; the server may unfurl a URL after saving. A run reports success only when the JSON response has `saved: true` and nonempty `nodeId`, `dailyNoteId`, and `date`. Otherwise it displays the response's `error` and `message`. There is no persistent queue: it is online-only, and one run can create at most one bullet.

The attempt ID, date, and text are action outputs created before the request. A retry added around only the request/receipt actions must reuse those outputs. Starting the shortcut again is a fresh invocation and creates a fresh attempt ID. The stock template does not automatically retry.

## Author and validate (Linux or Mac)

Load the repo-local [Cherri skill](../.agents/skills/cherri/SKILL.md) before
editing the source. It is vendored unmodified, with its MIT license, from
[the maintainer's skill revision](https://github.com/electrikmilk/cherri-skill/commit/3c88722937620078f8042812e867ac00684df8d2).
Use the installed compiler's `--no-ansi --action=` lookup for action signatures;
prefer constants for immutable outputs and check compiled action counts when
proposing simplifications. Preserve blank-input rejection, device-local Today,
per-invocation attempt IDs, the bound key Text action, and complete-save receipts.
The skill's general signing examples do not override this project's
`--skip-sign` build and Apple-only signing workflow.

The Cherri source is the canonical template; `--build` compiles it into
`shortcuts/Dotflowy.unsigned.shortcut`, outside `public/`. The generated XML is
deterministic and remains available to unit tests after signing. Building cannot
replace the public signed file with an unsigned download.

Install the pinned compiler once (the orb setup script does the same):

```sh
curl -fsSL -o /tmp/cherri.zip \
  https://github.com/electrikmilk/cherri/releases/download/v2.3.0/cherri_linux-x86_64.zip
unzip -o /tmp/cherri.zip -d /tmp/cherri-bin
install -m 0755 /tmp/cherri-bin/cherri "$HOME/.local/bin/cherri"
```

```sh
bun scripts/shortcut.ts --build
bun scripts/shortcut.ts --validate
bun test scripts/shortcut.test.ts
```

`CHERRI_BIN` points the build at a specific compiler binary. Validation checks
that every action identifier is one Shortcuts knows, that the only import
question targets the capture-key Text field, that the unsigned XML serialization
is reproducible, that the receipt gates and date format survive, and that no
credential marker is present. It also requires a signed AEA1 envelope at the
public path. Envelope checks do not decrypt or compare the signed payload; the
unsigned input is validated before signing. This is not a substitute for Apple's parser or
real-device testing: the action plist schema is an Apple implementation detail
rather than a documented stable authoring API.

## Sign and release (Mac required)

Use a Mac signed in to iCloud with Shortcuts enabled and network access. Apple's CLI sends the shortcut to Apple for validation. The build step also needs the Cherri compiler on `PATH`; only `--sign` is Apple's CLI. From the repository root:

```sh
bun scripts/shortcut.ts --build
bun test scripts/shortcut.test.ts
bun scripts/shortcut.ts --sign
bun scripts/shortcut.ts --validate
```

`--sign` executes the Apple-documented command with an atomic output replacement:

```sh
shortcuts sign --mode anyone \
  --input shortcuts/Dotflowy.unsigned.shortcut \
  --output public/shortcuts/Dotflowy.shortcut.signed.shortcut
```

It then moves the signed output to `public/shortcuts/Dotflowy.shortcut`.
Only the signed file belongs in `public/shortcuts/`. Building refreshes the
separate unsigned input, so a changed source still requires signing before
publication. Keep the final release sequence build, test, sign, validate.
The static download headers specify an attachment named `Dotflowy.shortcut`.

Before general release, import the signed file on a current iPhone and verify both direct launch and the share sheet with text and a URL, blank/cancel, a valid key, an invalid key, a server error receipt, and an offline request. Confirm a successful run creates exactly one bullet in the phone-local daily note. Keep discovery experimental until these checks pass.

Before claiming that sharing clears the capture key:

1. Customize a separate test copy with a unique dummy key that cannot authorize
   a real capture. Do not use a working key or change the clean master.
2. Share the configured test copy through Shortcuts' iCloud sharing mechanism.
3. Import the shared copy as a fresh recipient installation. Confirm setup asks
   for a capture key and inspect its actions to verify the dummy key is absent.
   Enter a different dummy answer and confirm the request references the newly
   configured Text action, not the sender's key.
4. Record the iOS version, sharing method, and result. If file export is offered
   or described as clearing keys, repeat the fresh-recipient check for that path
   separately. Do not infer its behavior from the iCloud result.

These sharing checks remain unverified. Official file distribution does not
depend on sharing a configured copy; retain the checks before making claims
about personal-copy sharing or export.

For each release, rebuild, test, sign, validate, and verify a fresh recipient
import of the signed file. Confirm its name and icon, one capture-key setup
question, and setup-answer persistence. With deployment approval, publish that
signed file at the same `app.dotflowy.com` URL. The asset's default revalidation
and ETag select fresh bytes for new downloads, not updates to installed copies.
Test the handoff from both Safari and Dotflowy's Home Screen PWA on a real
iPhone. Provide a way to copy the file link and open it in Safari if the PWA
handoff fails. Neither this handoff nor its fallback has been verified yet.

## Known platform limit

Shortcuts' **Get Contents of URL** action exposes neither a portable per-request timeout setting nor catchable transport errors in this plist workflow. Consequently, the template cannot promise a particular timeout or offer an in-shortcut retry after DNS, TLS, or offline failure; iOS presents the action failure and stops. Server-returned JSON failures are explicit. A transport failure does not prove the capture failed: check today's note before launching again. A new invocation uses a new UUID and can duplicate a capture whose acknowledgment was lost. The server's idempotency guarantee applies only to retries that preserve the original attempt ID.

References:

- [Apple: Run shortcuts from the command line](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac) — signing modes and command.
- [Apple: Add import questions](https://support.apple.com/guide/shortcuts-mac/add-import-questions-to-shared-shortcuts-apdf330fd3a0/mac) — setup-question behavior.
- [Apple: Share shortcuts](https://support.apple.com/guide/shortcuts/share-shortcuts-apdf01f8c054/ios) - iCloud links and recipient installation.
- [Apple: Modify shortcut colors and icons](https://support.apple.com/guide/shortcuts/modify-shortcut-icons-apd5ad5a2128/ios) - built-in glyphs and colors.
- [Apple: Add a shortcut to the Home Screen](https://support.apple.com/guide/shortcuts/add-a-shortcut-to-the-home-screen-apd735880972/ios) - custom Home Screen images.
- [iOS Shortcuts Reference](https://github.com/sebj/iOS-Shortcuts-Reference) — reverse-engineered plist fields; Apple does not publish the action serialization schema.
- [Shiori's signed shortcut](https://www.shiori.sh/Shiori.shortcut) — inspected only as an `AEA1` Apple-signed envelope precedent; no branding or credential was copied.
