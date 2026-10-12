# Link title unfurl: paste a URL, swap in its title

The original design below records the bare-URL implementation. The October 8,
2026 amendment expands its triggers and matching rules and adds Embed nodes.
X renders through its official client widget without server-side tweet fetching,
storage, or transformation.

**The feature.** Paste a bare URL into a bullet and the link's label upgrades from the raw url to the page's real title — `[https://anthropic.com](...)` becomes `[Anthropic](...)`. The browser can't read a cross-origin page's `<title>` (CORS), so the title comes from a new auth-gated Worker endpoint that fetches the page server-side. The label swap is asynchronous: paste is instant, the title lands a beat later.

**Trigger: the bare-URL paste only.** Of the three link-producing paste paths (bare URL → `[url](url)`, URL-over-selection → `[selection](url)`, rich anchor → `[clipboardTitle](url)`), only the first gets unfurled. It's the only case whose label is a throwaway url begging to be a real title; the other two already carry a meaningful label the user (or the source app) supplied, and overwriting them would destroy intent. Hand-typed links are never fetched (no network on keystrokes).

**The swap is verbatim-match-or-drop.** The fetch is async, so between paste and title-arrival the user can keep typing, hand-edit the label, navigate away, or delete the bullet — and we must not clobber a label they've since made their own. At paste time we know the exact string we inserted (`[<url>](<encoded-url>)`); when the title arrives we read the node's _current_ text and replace the label half **only if that exact substring is still present** (first occurrence). Gone → silently drop the title, the url-label placeholder stays. No parsing, no fuzzy match. This also makes the failure path free: a failed/blocked/timed-out fetch simply never swaps, and the placeholder _is_ the graceful fallback (a working, folded, favicon'd, url-labeled link).

**A new `input.afterPaste` seam keeps the core generic.** Unfurl is link-specific, so by the plugin architecture (ADR 0001) it can't leak into the core paste handler. The existing `input.onPaste` is `(PasteInput) => string | null` — pure, synchronous, no node id, no write path — and todos depends on that purity, so it isn't overloaded. Instead the core's `pasteIntoBullet` gains a node id + a `PluginContext` factory and, after the sync insert, calls `registry.afterPaste(inserted, nodeId, ctx)`. The links plugin owns every detail there: recognize its own bare-url placeholder, fetch, verbatim-swap via `ctx.mutations.onTextChange` (the atomic single-field PATCH — a **field edit, not structural**, so it never routes through `runStructural` and never waits on an echo).

**The loading state is ephemeral DOM, never source.** While a fetch is in flight the folded `<a>`'s favicon slot shows a spinner, the url label stays visible, the link stays clickable. This rides the existing `flash-node.ts` transient-class mechanic (the same one-shot-class pattern as moved-bullet flash and `rejectRow`): `afterPaste` finds the just-folded anchor and adds `.link-unfurling`; CSS swaps favicon→spinner. Success re-decorates the line (fresh anchor, no class); failure removes the class. Crucially this keeps the token `render` a **pure function of (text, caret)** — the loading state lives only in transient DOM, never in `node.text`, never in the decorate render-cache. A spinner that _replaced_ the whole link was rejected: it would hide a usable link to show a non-clickable spinner, then transition twice.

**The endpoint is deliberately dumb for the client.** `GET /api/unfurl?url=<encoded>`, slotted into `handleApiRequest` right after the session gate (auth-only, like `/api/nodes`); GET so it's idempotent and cacheable. It returns `{ title: string | null }` and nothing else — no favicon (the client already derives that from the host via Google s2/favicons, ADR 0005-era rich-links), no resolved final url (the client matches on the url it _inserted_, not the redirected one). Status model: `400` **only** when the `url` param is missing or not http(s) (a typed `BadRequest`, the ADR 0014 trust-boundary pattern); `200 { title: ... }` for everything else, with `null` for not-found / non-HTML / unreachable / timed-out / blocked-by-guard. Every "couldn't get it" collapses to `200 {title:null}` because the client does the identical thing for all of them (keep the placeholder), so distinct codes would buy nothing client-side; the _reason_ is logged server-side.

**Server-side fetch is the security boundary, so it's ours.** The endpoint fetches a user-supplied URL — an authenticated SSRF surface. Hardening, all server-side: scheme allowlist (http/https, doubling as the url validation); a hostname denylist (`localhost`, `*.local`, `*.internal`, `0.0.0.0`, private-range IP literals) on top of Cloudflare's platform-level block of direct-IP `fetch`; `redirect:"manual"` with at most ~3 hops, **re-running the hostname checks on every `Location`** (blind redirect-following is the classic bounce-into-a-blocked-target); no credential/cookie forwarding (anonymous fetch); a 5s `AbortSignal` timeout; a 64KB read cap; and a content-type gate. Recognized providers whose useful metadata sits beyond that bound must expose a bounded metadata endpoint rather than weakening the cap for every URL. **Residual risk, accepted for v1:** DNS rebinding — a public hostname that _resolves_ to a private IP slips a hostname-string check, and Workers' fetch doesn't cleanly let us resolve-then-pin. The auth gate (signed-in users only) + per-user rate limit blunt it; closing it fully on Workers is disproportionate now.

**Extraction is hand-rolled, not a dependency.** `tldraw/cloudflare-workers-unfurl` (MIT) has excellent HTMLRewriter extraction, but its `unfurl()` does its own _unguarded_ fetch (follows redirects, no timeout, reads the whole body via `.blob()`) and couples fetch+parse with no seam to inject our hardened fetch — so importing it ships exactly the posture above that we reject. We borrow the proven part: a minimal HTMLRewriter title extractor adapted from it (MIT-attributed in a comment), preferring `og:title` → `twitter:title` → `<title>` (og:title is usually the clean page-intended title; raw `<title>` is often cluttered). We need only `title` (per the contract), so its description/image/favicon machinery is dropped as dead weight.

**YouTube videos use YouTube's oEmbed representation before HTML.** YouTube watch pages can place their title hundreds of kilobytes into a megabyte-scale response, so raising the global byte cap or scraping undocumented player state would make every unfurl costlier and remain brittle. Exact YouTube-owned hosts and recognized video paths (`watch`, `youtu.be`, `v`, Shorts, embed, Live; including mobile and Music subdomains) are reduced to their validated 11-character video id. The Worker asks the fixed, keyless `https://www.youtube.com/oembed` endpoint for the canonical watch URL, accepts only JSON, and uses only its sanitized `title`. The user's original URL remains verbatim, including timestamps. An oEmbed miss or malformed response falls through to the same bounded HTML extractor; all fetching still shares the redirect guard and total timeout. This is a narrow provider exception, not a generic provider seam: one provider does not justify that abstraction, and oEmbed remains best-effort rather than a Google-documented availability contract.

**Sanitization is split by who builds the markdown.** The server returns a reasonable title (entity-decoded, whitespace-collapsed, trimmed, length-capped ~300, `null` if empty). The **client** does the markdown-label-safety pass right before constructing `[title](url)`: strip `]` (fatal to the `[^\]]*` label regex — a stray `]` would corrupt the node's other tokens) and re-collapse whitespace; empty after → keep the placeholder. It lives client-side because the client constructs the token, and it's a pure function (unit-tested under the "pure logic only" rule).

**Hygiene: cache + rate-limit.** Titles aren't user-specific, so successful non-null results are cached across all users in the Cloudflare Cache API for ~24h — the common "same link pasted again" case then skips the outbound fetch. Ordinary pages key by their URL; recognized YouTube forms key by canonical video identity so timestamps and alternate URL forms share one title. Failures are not cached. A per-user rate limit (~30/min, keyed on `user.id` via Cloudflare's native Rate Limiting binding, not DO counters — the outline DO stays single-purpose) caps the scanner-abuse vector that the auth gate alone leaves open.

**Don't:** unfurl any paste case but the bare URL (the others carry intent); swap on anything looser than a verbatim placeholder match (you'll clobber edited labels); route the swap through `runStructural` (it's a field edit — direct PATCH, no echo-wait); put the loading state in `node.text` or read ephemeral state in the token `render` (use the transient `.link-unfurling` class, like flash/reject); follow redirects without re-validating each hop, or relax the hostname/scheme guard to "just fetch it"; or import `cloudflare-workers-unfurl`'s `unfurl()`/`handleUnfurlRequest` wholesale (its fetch is unguarded — borrow only the extractor, with attribution).

## October 8 amendment: broader unfurling and the Embed design

The [design discussion](https://ampcode.com/threads/T-01a11b06-db90-778c-b9c4-3a65a3881332)
on October 8, 2026 established this scope. General unfurling, Embed nodes,
the optional plugin, and account permission are implemented in this change.
The official X client widget is also implemented after provider validation.

**Implemented stage.** Ordinary title lookup now covers single-line and
structural paste, unlabeled Add Link, browser Quick-add, external capture, and
MCP text-authoring tools (also used by the CLI). It handles multiple new URLs
within prose. Shared scanning skips custom labels, code, spoilers, credentials,
and old URLs. Literal paste and fenced structural-paste lines never trigger
lookup. A URL already present in a node is conservatively skipped even when
pasted again. There is no backfill and no fetch on keystrokes, imports, moves,
mirrors, or generic persistence.

Structural paste and Quick-add wait for persistence before lookup. Browser results
rescan live text before replacing eligible tokens, preserving other edits and
concurrent title results. Worker results compare the original text inside the
DO transaction and drop the whole upgrade if it changed, was deleted, or became
locked. External capture retains its receipt and credential revalidation.
Lookups reuse the existing guarded fetch, cache, and per-user quota. Failures
leave text unchanged. This supersedes the original bare-URL-only trigger and
first-occurrence replacement rules above.

- The initial preference was tweet text as the external link's readable label,
  not a rich card or imported child nodes. After reviewing X's display and
  retention requirements, the discussion shifted to exploring an official
  preview as a compiled-in plugin. The agreed Embed model below supersedes
  that initial label-extraction goal.
- Cover paste, Add Link, browser Quick-add, external capture/Shortcut, and
  CLI/MCP writes.
- Do not backfill old URLs.
- Apply the expanded entry points to other websites too, including YouTube.
- Enrich newly added bare URLs within prose as well as standalone URLs,
  including multiple new URLs. Preserve custom labels and skip code, spoilers,
  and literal paste. Editing an old node must not enrich pre-existing URLs.
- Include helpful information within reason. The earlier proposed tweet-label
  format is superseded by displaying the provider's embed.
- Prefer a stable provider with permitted use; a technically working endpoint
  is not sufficient evidence of either.

Before this change, CLI `add`, `subtree`, `update`, and `today` called MCP tools
that committed supplied text without unfurling. YouTube-specific fetching only
runs when the unfurl service is called. Those tools now schedule it after a
successful write, as external capture already did.

**X content must not become stored outline data.** The initial suggestion to
extract oEmbed text into a permanent, truncated label was rejected.
X's [display requirements](https://docs.x.com/developer-terms/display-requirements)
require unmodified post text, author attribution, a timestamp, branding, and
post actions or a View on X link. Its
[developer policy](https://docs.x.com/developer-terms/policy) also requires
handling content changes and removals, and restricts redistribution. The
official client renderer satisfies that boundary without Dotflowy fetching,
storing, transforming, exporting, or exposing tweet data through MCP. The node
stores only the source URL.

**Agreed model: explicit Embed nodes.** Cam initially wanted automatic
previews beneath node text, then reconsidered after comparing Notion's paste
choices. One external resource is its own node,
selected deliberately rather than automatically rendering every URL in prose.
Embed is a fourth core Kind, with provider rendering owned by the plugin. The
node can have child notes, move, collapse, zoom, and be mirrored. The external
content is read-only; the URL can be replaced or the node converted back to an
ordinary node. X and YouTube are the initial targets, not an exclusive provider
list. Additional providers are welcome when official, standards-based support
fits the same small implementation without paid infrastructure.

**Plugin ownership.** Embeds is an optional, reviewed, compiled-in editor plugin,
following ADRs 0001 and 0064. Core owns the Kind, stored URL, tree behavior, and
interchange; the plugin owns provider rendering. This is not runtime plugin
loading. Turning the plugin off leaves Embed nodes and child notes intact.

**Paste choices.** A standalone URL pasted into an empty node defaults to Link,
with a non-blocking choice of Link Title, Plain URL, or Embed. Unsupported URLs
still show the menu, with Embed disabled.
The bare URL is inserted immediately, but no title or provider request starts
until the user chooses. If initial preferences are pending, the paste waits for
them before showing the chooser. If Embeds is disabled, it uses direct title
lookup instead. A changed or unmounted source drops the deferred choice.
Link creates Markdown and unfurls the title; literal URL
does no metadata work; Embed changes the Kind and loads only its provider after
permission. Pasting into existing prose stays inline. Notion-style bookmark
cards are deferred; Dotflowy's Bookmark means pinning a node.

The same radio-style display menu remains available for all three pure forms:
one supported-provider URL, one Markdown link to a supported-provider URL, or an
Embed. A muted, outlined More button before the source is always visible; the
current form is checked and disabled. Adding any other text makes the node
ordinary prose and removes the menu. This keeps a dismissed paste choice and
every later conversion reversible without storing a representation field.
Initial paste and existing-node actions share one menu implementation. Its
popover portals outside the outline canvas so horizontal overflow cannot clip
it.

Changing an Embed to Link or literal URL preserves its children and needs no
confirmation: choosing the named representation is sufficient intent. Link
starts the normal guarded title lookup; literal URL makes no metadata request.
For mirrored content, the menu says “Changes all N instances” and then applies
the choice without a second dialog, because Kind and text are source-owned.

**Permission.** One account-wide permission covers supported external embeds,
not a separate permission per browser, provider, or preview. This supersedes the
earlier browser-local proposal. Settings can revoke it. Plugin availability and
permission to contact providers are distinct: rendering requires both. The
disclosure must explain automatic loading across the account's devices and that
providers receive network requests and may use cookies or tracking. Its final
wording still needs review. Quick-add stays text-only while capturing; the Embed
can render later in the outline.

Reuse the existing per-user `account-prefs` storage. The implementation
recommendation is permission denied by default, no external embed requests
before the preference is loaded and an approval is persisted, and immediate
unmounting when permission is revoked locally. Follow ADR 0064's focus refresh
for other tabs and devices; this is not an instantaneous cross-device revocation
guarantee and cannot undo requests already made. Do not copy existing features'
enabled-by-default behavior for external loading permission.

Existing URLs may offer embeds without any backfill or rewrite of stored text.
Embeds are reading-only: their content does not become node text, searchable
outline content, exported text, or content returned by CLI/MCP reads. An
unavailable or deleted post may lose its preview. These tradeoffs are accepted.

**External tools.** CLI/MCP callers explicitly request the Embed kind. Ordinary
adds remain ordinary nodes with title unfurling. External tools can create an
Embed node but cannot grant account permission to load external content.

**Failure and disabled state.** If a provider cannot embed the URL, convert the
node to Link, start the normal guarded title lookup, preserve child notes, and
say “URL couldn’t be embedded, kept as a link instead.” If title lookup also
fails, the URL remains usable. This follows the default representation instead
of maintaining an Embed-specific retry state. A late provider result must be
ignored after the user switches representation. Turning off the plugin is
different: it does not rewrite stored Embed nodes. Provider deletion, protected
content, network failure, or blocked embedding must never delete the node or
its children.

**Interchange.** Markdown copy/export emits a readable URL and preserves child
notes, but loses the Embed kind on reimport. This is an explicitly accepted
exception to the kind-round-trip rule in ADR 0045, in favor of portable Markdown
rather than a Dotflowy-only syntax. Preserve the Embed kind and URL in MCP data
and OPML. Never export the provider's rendered HTML or fetched post content.

Reviewed `row:body` and `title:body` slots render below editable source text,
outside the trailing decoration budget. Core retains the source link when the
plugin is disabled. ADR 0031 records this outline-surface exception. Kind crosses
the shared data, editing, CLI/MCP, and export boundaries; it is not plugin-owned
metadata (ADR 0045). Quick-add has no body slot.

[Notion's documentation](https://www.notion.com/help/embed-and-connect-other-apps)
distinguishes inline link mentions, bookmark blocks, and embeds, and states
that Notion uses Iframely. Iframely's
[consent feature](https://iframely.com/docs/consents) supports per-site
"Allow all media" permission, stored in browser-local storage. That storage
scope differs from the agreed account-wide permission. Neither
Notion's usage nor Iframely's technical support establishes Dotflowy's rights
to use provider content.

**Cost constraint.** Keep the feature as free as possible. Prefer direct
official embeds for supported providers over a paid intermediary, subject
to the remaining isolation and terms checks. Ordinary hosting, maintenance,
and provider availability still have costs. On October 8, 2026,
[Iframely's hosted Starter plan](https://iframely.com/plans) lists 2,000 free
monthly hits and $0.40 per 100 additional hits. Its MIT-licensed
[self-hosted server](https://github.com/itteco/iframely) can fetch X/YouTube
embeds but requires a Node service, is not a drop-in Worker deployment, and
does not include hosted consent interactives. For this small provider scope,
direct embeds and the existing account-preference infrastructure are the
current recommendation, not a
commitment to an untested integration.

**Additional provider boundary.** Use an explicit allowlist of supported
providers and resource URL forms, not arbitrary oEmbed discovery or execution of
returned HTML in the app document. The protocol standardizes responses, not
their safety or permission to use content. Official
[Spotify](https://developer.spotify.com/documentation/embeds/reference/oembed)
and [Vimeo](https://developer.vimeo.com/api/oembed/videos) documentation shows
iframe-based responses, making them reasonable candidates for the same provider
path. These candidates have documentation evidence, not browser compatibility
verification yet. Preserve required URL details, such as Vimeo's unlisted hash,
and respect provider embedding restrictions. Defer any provider that needs a
separate authentication flow, scraper, paid service, or substantial custom work.

UI placement does not isolate third-party JavaScript. The X integration accepts
that tradeoff and loads X's documented `widgets.js` in the app document only
after account-wide external-embed permission is enabled. The
[oEmbed specification](https://oembed.com/#section3) recommends a separate-domain
iframe for provider HTML; oEmbed itself grants no content permissions.

**X feasibility result, October 8, 2026.** A disposable browser experiment
rendered the official widget in a separate-origin iframe with scripts and
same-origin enabled inside the sandbox. The app document did not load X's
script or gain access to the child document. Without `allow-same-origin`, the
widget did not transform. `allow-same-origin` preserves the child's own origin;
it does not make a different-origin child same-origin with the app.

**Oracle review corrected the initial interpretation.** Section III.K of the
[X Developer Agreement](https://docs.x.com/developer-terms/agreement) contains
an absolute iframe prohibition, but X's own
[CMS guide](https://docs.x.com/x-for-websites/embedded-posts/guides/cms-best-practices)
shows an outer iframe containing the official widget and `widgets.js` for
Facebook Instant Articles. That specific example contradicts a blanket claim
that official widgets cannot use iframes, without clearly authorizing arbitrary
website wrappers. The finding is conflicting official guidance, not a settled
prohibition or permission for Dotflowy's wrapper.

Cam subsequently validated the intended use: a user pastes a post URL and the
official embed renders client-side, unmodified. Risk rises if Dotflowy fetches,
stores, or transforms tweet data on its servers, so those behaviors remain out
of scope. The documented
[`createTweet` factory](https://docs.x.com/x-for-websites/embedded-posts/guides/embedded-post-javascript-factory-function)
renders from the post ID without an oEmbed proxy or stored post text. Do not
substitute a scraper, server-side tweet lookup, or stored tweet content.
The shared outbound guard rejects X and Twitter hosts before reading the title
cache and on every redirect hop, including general title lookup and Embed fallback.
Source URLs remain clickable when no title is available.

Keep the agreed general unfurl improvements and embed nodes as separate
delivery stages, with general unfurl consistency first. The product decisions
above are confirmed, including account-wide permission and the optional plugin.
Direct-provider feasibility and isolation remain technical checks for future
providers.

**Implementation sequence.**

1. Expand general unfurling across the agreed entry points. Preserve custom
   labels, literal input, and existing URLs; drop late results after edits or
   deletion. Keep network fetching out of generic outline persistence.
2. Validate official provider rendering and isolation with a small browser
   experiment before committing to the embed host. For X, use only the official
   client renderer and keep tweet data out of the Worker and outline storage.
3. Add the Embed Kind across storage, mutation validation, CLI/MCP, mirrors,
   filters, and interchange. Add the reviewed node-body rendering contract and
   amend ADRs 0031 and 0045 for the agreed exceptions. Wire the optional plugin,
   account permission, paste choices, and Settings into that contract.
4. Verify consent-off causes no external embed requests; approval failure stays
   off; revocation removes active embeds; disabled or failed providers preserve
   URLs and children. Exercise rows and zoomed nodes, narrow screens, resizing,
   keyboard navigation, drag, mirrors, and text-only Quick-add. Check CLI/MCP
   creation, OPML preservation, and the intentional Markdown kind loss.

## Implemented provider and sizing boundaries

YouTube, Vimeo, and Spotify use their fixed official oEmbed endpoints. The
session-gated `/api/embeds` also checks saved account consent and the per-user
unfurl quota. The bounded fetch keeps its redirect guard and only accepts the
same fixed endpoint on redirects. Effect Schema decodes JSON; HTMLRewriter
extracts iframe sources. Exactly one iframe must match the requested provider
and resource ID. The response contains only a validated source URL, dimensions,
and title, never provider HTML. React constructs the cross-origin iframe; no
provider script runs in the app document for these three providers. Spotify
falls back to its deterministic official player URL when oEmbed is unavailable.
X bypasses `/api/embeds`: the browser loads the official widget script and calls
`createTweet` with the post ID, `dnt: true`, and the current theme.

Video frames reserve the provider's aspect ratio, including non-16:9 videos.
Spotify uses its reported height when available; its fallback reserves 152px
for tracks and episodes and 352px for other supported resource types. A quiet
placeholder precedes a 150ms opacity reveal; reduced motion disables the fade.
There is no new preview-collapse control. Subtree collapse remains instant
under ADR 0019. X content uses the official widget's measured height rather than
a stored aspect ratio. Deliberate body opening may animate height for about
200ms; later provider resizes must not repeatedly slide. No dimensions belong
in Node storage.

The window virtualizer measures body height and anchors an edited row when a
preceding row resizes. Zoomed body resizing updates the list's scroll margin.
Descriptors are cached only in memory for an hour to avoid repeat lookups on
virtual remounts. A failed lookup follows the Link fallback above. An iframe
load event cannot establish that provider playback is available;
provider-rendered errors remain visible, and Open source is always available.
