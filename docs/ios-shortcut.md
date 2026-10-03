# Add to Dotflowy Today — Apple Shortcut

The official template is [`/shortcuts/add-to-dotflowy-today.shortcut`](../public/shortcuts/add-to-dotflowy-today.shortcut). It accepts text or a URL from the iPhone share sheet. When launched directly, it asks “What do you want to add to today?”; the standard keyboard dictation button works in that text field. Cancelling or submitting only whitespace sends nothing.

## Release state

The checked-in file is currently an **unsigned XML property-list template**.
Cam reports successful Mac signing and import. The experimental installer uses
[Cam's shared shortcut](https://www.icloud.com/shortcuts/73918f14013646a1a36252939c26db46).
The orb could not inspect the shared payload: Apple's record request returned
HTTP 503. Its credential-free contents and end-to-end capture still need
real-device verification before general release.

Import asks for:

1. A Dotflowy capture key. The repository contains only the placeholder `PASTE_CAPTURE_KEY_DURING_IMPORT`, never a working credential.
2. The capture endpoint, defaulting to `https://app.dotflowy.com/api/capture`. Self-hosters can replace it.

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

**Add to Apple Shortcuts** opens the supplied iCloud link without including a
key. **Copy installation link** provides a Safari fallback for Home Screen PWA
handoff. If automatic copying fails, a selectable link field appears. The
unsigned artifact is not offered as an install download. Opening the sharing
link does not confirm installation.

## Keep the shared master separate from personal copies

Keep a clean master in the Shortcuts app, optionally in a **Dotflowy Templates**
folder synced through iCloud. Name it **Add to Dotflowy Today** and leave its
key field as `PASTE_CAPTURE_KEY_DURING_IMPORT`. Duplicate it for personal use
and put your real key only in that private copy. Generate the public iCloud
link from the clean master, not the configured personal copy.

The repository's `scripts/shortcut.ts` remains the canonical action definition;
`public/shortcuts/add-to-dotflowy-today.shortcut` is its generated artifact. A
signed export of the clean master can be retained with the release, but never
commit or upload a personalized shortcut containing a working key.

In the iPhone shortcut editor, tap the icon beside its name to choose a glyph
and color, then tap **Done**. A custom image is a separate **Add to Home Screen**
option, not the shortcut collection's glyph. After changing the shared master's
name or icon, share it again and update the installer URL if Apple supplies a
new link. Re-import that link to verify what recipients receive.

## Behavior and protocol

Each nonblank invocation creates an attempt UUID and formats the phone's current local date as `yyyy-MM-dd` immediately before submission. It sends:

```http
POST /api/capture
Authorization: Bearer <capture key>
Content-Type: application/json

{"attemptId":"<UUID>","date":"yyyy-MM-dd","text":"<input>"}
```

The optional `title` field is intentionally omitted by this stock template; the server may unfurl a URL after saving. A run reports success only when the JSON response has `saved: true` and nonempty `nodeId`, `dailyNoteId`, and `date`. Otherwise it displays the response's `error` and `message`. There is no persistent queue: it is online-only, and one run can create at most one bullet.

The UUID, date, and text are action outputs created before the request. A retry added around only the request/receipt actions must reuse those outputs. Starting the shortcut again is a fresh invocation and creates a fresh UUID. The stock template does not automatically retry.

## Author and validate (Linux or Mac)

The TypeScript source is the canonical template; generated XML is deterministic.

```sh
bun scripts/shortcut.ts --build
bun scripts/shortcut.ts --validate
bun test scripts/shortcut.test.ts
```

Validation checks required action structure, import-question targets, deterministic output, receipt gates, and common credential markers. It is not a substitute for Apple's parser or real-device testing. The action plist schema is an Apple implementation detail rather than a documented stable authoring API.

## Sign and release (Mac required)

Use a Mac signed in to iCloud with Shortcuts enabled and network access. Apple's CLI sends the shortcut to Apple for validation. From the repository root:

```sh
bun scripts/shortcut.ts --build
bun test scripts/shortcut.test.ts
bun scripts/shortcut.ts --sign
bun scripts/shortcut.ts --validate
```

`--sign` executes the Apple-documented command with an atomic output replacement:

```sh
shortcuts sign --mode anyone \
  --input public/shortcuts/add-to-dotflowy-today.shortcut.unsigned \
  --output public/shortcuts/add-to-dotflowy-today.shortcut.signed
```

It then moves the signed output to `/shortcuts/add-to-dotflowy-today.shortcut`. Do not run `--build` afterward, because that deliberately restores the unsigned source artifact.

Before release, import the signed file on a current iPhone and verify both direct launch and the share sheet with text and a URL, blank/cancel, a valid key, an invalid key, a server error receipt, and an offline request. Confirm a successful run creates exactly one bullet in the phone-local daily note. Only then should the signed bytes be committed and the download be called installable.

Share the validated, credential-free shortcut through iCloud and verify the
recipient's import questions. Add the verified sharing URL to the setup dialog.
Test the handoff from both Safari and Dotflowy's Home Screen PWA on a real
iPhone. Provide a way to copy the sharing link and open it in Safari if the PWA
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
