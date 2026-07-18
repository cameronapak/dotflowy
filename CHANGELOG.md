# dotflowy

## 1.6.0

### Minor Changes

- f468f05: You can now delete your account yourself, from the header More menu. Deletion is
  permanent and immediate: it cancels any active subscription, erases your outline,
  removes your account, and signs you out. Export your outline as OPML first if you
  want a copy.
- 298afc7: Read the Terms of Service and Privacy Policy in the app at /terms and /privacy, linked from the signup screen and the More menu.
- b9e1c5d: New Settings page: plan & billing, account, connections, data, and appearance in
  one place. Free accounts see their node usage and can upgrade to Unlimited ($5/mo
  or $48/yr) or Founding ($99 / 3 years); paid accounts can manage or cancel their
  subscription. Reach it from the header More menu — which is now slimmer, since
  theme, text size, import/export, connect apps, and account controls all moved to
  Settings.

### Patch Changes

- a28b60a: Opening or filing into a daily note is more reliable: creating today's note now waits for the write to durably land before navigating, so a failed save shows a clear message instead of dropping you on a note that vanishes, and "Send to Today" no longer misfiles a node when today's note was just created. Quick-add now keeps your draft and shows an error if today's note can't be opened (instead of silently filing the capture at the top level), and hitting the free-plan limit while opening a daily note shows only the upgrade notice, not a second generic error.
- 12b66cb: Harden and unit-test the Worker's auth/identity gates: the DO tenant-isolation key (`resolveUserId`), admin allowlist, invite-code backdoor, and email shape check are now a pure, tested module; `BETTER_AUTH_SECRET` is asserted at startup (fail-closed, not silently insecure); admin access can now be pinned to a stable `user.id` (`ADMIN_USER_IDS`) instead of an unverified email; and the SSRF unfurl guard now blocks IPv4-mapped IPv6 loopback/private targets.
- 0d0a93d: Supervise the live-sync consumer so a bad inbound frame can no longer silently kill sync: the fiber now logs the failure and re-establishes (fetching a fresh snapshot) up to a bounded budget, then shows a persistent "Sync interrupted — reload" notice instead of dying quietly while the connection still looks alive.
- 0eede6b: Surface a toast when an outline write fails and rolls back, instead of the edit vanishing silently.

## 1.5.0

### Minor Changes

- a741fe4: Every outline is now backed up off-site daily: an automatic sweep exports each account's full outline to separate storage (kept ~90 days), and an operator can restore any account from any day's snapshot — covering losses older than the existing 30-day point-in-time recovery window.

## 1.4.0

### Minor Changes

- f032a3b: Daily notes now organize themselves into a calendar: Daily > Year > Month > Week > Day, with ISO weeks (Monday start, a straddle week lives whole under the month owning its Thursday), everything sorted chronologically, and a week badge plus Cmd+K "This week" jump. Existing daily notes reorganize automatically the first time you touch them — one Cmd+Z undoes it.
- bc79155: Enforce free-tier entitlements: a free outline is capped at 10,000 live nodes (the DO refuses batches that would grow it past the cap, with an in-app upgrade toast; edits, moves, and deletes are never blocked and an over-cap outline is never locked), and MCP agent access now requires a paid plan (a free token can still handshake and list tools but every tool call is refused with an upgrade message). Paid plans are unlimited on both.
- 9d6c1aa: Waitlist members can now be turned into invited signups with per-email,
  single-use invite codes. An admin mints and emails them from the waitlist
  (`bun run invite`), and a code only works for the address it was sent to, once.

### Patch Changes

- 520ed5b: Your outline can now be restored to any point in the last 30 days. If an outline
  is lost or corrupted, an operator can roll one user's data back through the
  Durable Object's built-in point-in-time recovery — isolated to that user, and
  itself reversible with an undo bookmark.
- 49d5d78: The `/` command palette and the `#` / `[[` caret pickers now scroll the highlighted item into view, so arrowing past the visible window no longer walks the selection off-screen. Hovering still picks the item under your cursor, but a scrolling list can no longer steal the highlight out from under the arrow keys. Thanks to Dylan Shade (@dpshde) for the fix.
- 4450c9f: Clicking or drag-selecting the first characters of a to-do's text no longer completes it by accident. The checkbox had an invisible hit area reaching 12px past itself on every side — far enough to sit on top of the text beside it — so a click meant to place a caret landed on the checkbox instead. Its target is now the checkbox itself, and on touch it stays a comfortable 24px wide without growing the box or crowding the text.

## 1.3.1

### Patch Changes

- a76bfe7: The header filter magnifier now shows a subtle "engaged" state the moment you open it (before you've typed a query), and turns solid only once a filter is actually applied. Its active look now tracks what's happening: muted while the search box is just open, solid when your view is genuinely filtered.
- c8d1a19: Scrollable menus, command palettes, and dialog lists now fade softly at their edges when there's more to scroll, so it's clearer when a list runs past what's visible. The breadcrumb trail and mobile action bar get the same left/right hint. The fade dissolves content into the menu's own surface, and the `/` command menu and the `#`/`[[` caret menus now always stay fully on screen instead of clipping off the right or bottom edge. It's pure CSS with no runtime cost, and falls back cleanly to plain scrolling in browsers that don't support scroll-driven animations.

## 1.3.0

### Minor Changes

- ec7b12f: Quick-add: a distraction-free capture surface. Press `q` (or use the mobile capture button, or the Cmd+K "Quick add" action) to file a thought straight into today's note without ever looking at Today. Rapid-fire with Enter, retarget any capture with the Today chip, and see a running list of what you just captured.
- ec7b12f: Quick-add gets sharper capture flows. Enter now commits your thought and closes the overlay — and if you weren't looking at where it landed, a toast confirms it with a "Go there" jump. For a burst, Cmd+Enter commits and keeps the overlay open so you can fire off the next one. And turning a capture into a to-do (`/todo` or Mod+D) now shows the checkbox inline, right where you're typing.
- bd88c0e: Wire Stripe subscriptions via the `@better-auth/stripe` plugin: hosted Checkout
  (`subscription.upgrade()`), the webhook at `/api/auth/stripe/webhook`, and the D1
  `subscription` table (migration `0006`). Entitlement reads never call Stripe —
  `worker/plan.ts` resolves a user's plan from one D1 query — and the founding
  50-seat cap is enforced server-side at checkout creation. Billing secrets are
  optional in dev (unset = only the billing endpoints fail).

### Patch Changes

- 81d20da: Sharing a link to the app now shows the Dotflowy logo lockup and the new tagline instead of retired copy.
- ec7b12f: Quick-add now wears the same frame as the Cmd+K command center — a cleaner card with the destination chip trailing the input and a keyboard-hint footer. Same capture behavior, just more at home alongside the command palette.
- ec7b12f: Quick-add polish: the destination picker now opens as a popover anchored to the "Today" chip instead of rearranging the overlay, so your capture text never jumps while you retarget. On phones, the keyboard-shortcut hints (which you can't press anyway) are hidden.

## 1.2.1

### Patch Changes

- cf52c65: Drag-reorder now follows the active filter: while a `?q=` filter is on, drops target only the visible rows (landing right after the visible predecessor when the real tree has hidden siblings in between), and a drop that lands the node hidden shows a quiet toast instead of silently vanishing it.
- 651c480: Escape in the filter input reliably clears the text on the second press again — a deferred popover reveal from the summon animation no longer re-opens a popover you already closed.
- 37d1554: Keyboard navigation now works while a filter is active: Arrow Up/Down (and delete/selection focus landing) walk exactly the rows the filter shows, instead of silently getting stuck on rows the filter hid.
- 11aa087: Disable pinch-zoom on mobile.

## 1.2.0

### Minor Changes

- 1cd17ff: The header filter magnifier is now a toggle: press to open the filter, press again to clear the query and collapse the row. It lights up solid while a filter is active, so it reads as an on/off control. Filter autocomplete suggestions now ease in after the subheader finishes expanding instead of flashing at a stale position, and respect reduced-motion settings.
- 718f269: Forgot your password? You can now reset it from the sign-in screen — a reset link lands in your inbox and expires after an hour.
- 28e18c9: Dotflowy now installs to your home screen with a proper app icon (iOS and Android), and links to the app show a rich preview card when shared.

### Patch Changes

- 46aa0e4: When something goes wrong, the app now shows a recover screen instead of a blank page, and errors are reported to us (with your note text scrubbed out) so we can fix them faster.
- 008cc9a: Error reports now strip the query string from URLs and navigation breadcrumbs, so an active outline filter (`?q=`) or a pasted link can't ride an error report — closing a gap in the note-text scrub.

## 1.1.0

### Minor Changes

- e806f5a: Sign in with Google. Existing accounts connect Google from the More menu ("Connect Google") and can then use either sign-in method; signup stays invite-only, including through Google.

## 1.0.0

### Major Changes

- c77151c: Filter your outline with a query language, and a reworked header.

  **Relearn one gesture:** the header **magnifier now opens the filter**, not the node switcher. The switcher (Cmd+K) moves to a new **⌘ Command-center** button beside it — Cmd+K itself is unchanged.

  Press **Cmd+F** (or the header magnifier, or run "Filter this view" from Cmd+K) to open a filter box in the subheader, then type: free text (a case-insensitive substring of what you see), `"quoted phrases"`, `#tag`, `-` to negate any term, and uppercase `OR` between two terms. It also understands `key:value` operators — `is:todo`, `is:bullet`, `is:paragraph`, `is:mirror`, `is:complete`, `is:agent`, `has:link`, and `highlight:` (bare, or by color like `highlight:red`).

  Filtering is live as you type, and an autocomplete popover suggests operators, their values (with color swatches for highlights), and your existing tags — so nothing is hidden grammar you have to memorize. The filter box now stays resident showing the raw query (the old blur-into-pills behavior is gone); a trailing **X** clears it. A match reveals its own subtree (collapse is respected, and filtering never changes what's collapsed). Escape steps back one layer at a time: close the suggestions, then the text, then the box. The `?q=` filter is shareable and scoped to whatever you've zoomed into.

  **Save the filters you reuse:** click the **Pin** inside the filter box to save the current query (it syncs across your devices). Saved filters lead the filter popover — click to apply, hover to rename or delete — and appear in Cmd+K's empty state beside your bookmarks, ready to run.

### Patch Changes

- 6984fcc: Quieter "What's new" signal: the standalone header button is gone. Unread releases now show as a small notification dot on the "More" menu, and the "What's new" item is emphasized while unread.

## 0.3.0

### Minor Changes

- 19a57a1: Add a `/delete` slash command. Deleting a node was already reachable from the
  bullet keymap, Cmd+K, and the node-selection menu; this puts it in the `/`
  palette too, delegating to the same delete funnel (protection guards, the
  big-subtree confirm, atomic batch, and neighbor-focus all apply).

  The `/` palette and the `#` / `[[` caret pickers also now open on the zoomed
  page title, not just list bullets, so slash commands, tag autocomplete, and
  node-link autocomplete all work whether a node is a row or the title you've
  zoomed into.

## 0.2.0

### Minor Changes

- e89548d: Paragraph nodes. A bullet can now become prose: `/paragraph` swaps its dot for a pilcrow, and the line reads as writing instead of a list item. It stays a full citizen of the outline — it takes children, collapses, zooms, and can be completed — and the pilcrow sits exactly where the dot was, so it still zooms on click and drags to reorder. Copy-as-Markdown writes a paragraph as a plain line, and pasting plain lines brings them back as paragraphs. Agents can read and write them over MCP, and they survive an OPML round-trip.
- aaf904b: A changelog. Dotflowy now ships versioned releases: a "What's new" dialog with an unread badge in the app, and a public feed on GitHub Releases. A running tab notices when the server has moved on and offers to reload.

### Patch Changes

- dc2ebba: Signing out — or signing in on a tab someone else used — now fully reloads the app, so a previous account's outline can no longer appear in, or be written into, a newly signed-in account.
