---
status: accepted
---

# Share text and links into Today from the OS share sheet

The installed web app declares a `share_target`, so on platforms that support
it, Dotflowy appears in the system share sheet next to native apps. It extends
[External Quick-add](./0065-external-quick-add-with-capture-keys.md) beyond the
Apple Shortcut without a native app or a capture key. Cam chose Today as the
destination and a confirm tap before saving, and approved implementation; the
remaining defaults below were proposed as defaults he can change.

## Reach

Chromium only: Chrome and Samsung Internet on Android, ChromeOS, and PWAs
installed with Edge on Windows. Safari (iOS, iPadOS, macOS) and Firefox do not
implement share targets, so the Apple Shortcut stays the Apple path. A share
target registers only for an installed app; an Android home-screen shortcut is
not enough. Already-installed apps pick up the new manifest on the browser's
own schedule, and desktop installs may need a reinstall.

## Decisions

- **Today, through the capture intake.** A share lands in the device-local
  daily note through the same Markdown intake, idempotent replay, node limit,
  and background title lookup as the Shortcut. A lone link keeps the shared page
  title as its label. Android puts links in `text`, not `url`; the page appends
  `url` only when `text` does not already contain it.
- **One tap before any write.** Any site can post a form to `/share` or link to
  `/share#…`, and the session cookie (`SameSite=Lax`) rides the resulting
  same-site GET. So loading `/share` never saves. It shows the shared content
  with Add to Today and Cancel. The same class of bug, a site silently adding to
  a signed-in account, is routinely reported and paid for elsewhere; no
  share-target exploit was found.
- **Text and links only, online only, for every install.** The manifest declares
  no files, there is no service worker, and the share sheet entry is not behind
  Experimental: a manifest is global, so a flag could only hide the page, not the
  share-sheet entry.

## Flow and trust boundary

1. The manifest's `share_target` is `POST /share`, `multipart/form-data`, with
   `title`, `text`, and `url`. POST keeps shared text out of the request URL,
   which Workers invocation logs record. GET would log it.
2. The Worker answers `POST /share` before the static-asset fallback. It saves
   nothing and reads no session. It accepts only `Sec-Fetch-Site: none`
   (Chromium before 156) or `same-origin` (156 and later, which attribute the
   launch to the app), with no Origin, an opaque one, or a trusted one. It
   refuses `cross-site`, `same-site` (e.g. `e.dotflowy.com`), and requests
   without Fetch Metadata. It bounds the body, decodes it against Effect Schema,
   and answers `303` to `/share#<fields>` or `/share#error=…`. Invocation logs
   record the request URL and response status, not the `Location` fragment.
3. The `/share` route moves the fragment to `sessionStorage` before the auth
   gate renders, then removes it from the address bar. The share survives every
   same-tab sign-in path without riding an auth redirect or an error report.
4. Add to Today posts JSON to `POST /api/share`, which requires a browser
   session and a trusted `Origin`. It is a separate route from the key-only
   `/api/capture`: a capture key never authorizes `/api/share`, and a session
   never authorizes `/api/capture`. Both share one capture core and the per-user
   `capture:` rate limit. Background title upgrades recheck the session before
   writing. The attempt ID and date are fixed at first tap, so retries replay.

## Later: zero-tap

Saving without the tap is possible later, but only if the Worker saves during
`POST /share` itself, never the page from a URL. It must keep the Fetch Metadata
check above, fail closed, and require the session cookie on that POST. Real
Android Chrome, Samsung Internet, ChromeOS, and Windows Edge launches must first
show the expected headers. Any Android app can send a share intent; that stays
at the Shortcut's trust level.

## Verification

Real-Worker tests cover the launch handoff and refusals, the separate
credentials, and an end-to-end browser share through sign-in. Real-device share
launches on Android, ChromeOS, and Windows Edge are not yet verified. Neither
are the headers those launches send.
