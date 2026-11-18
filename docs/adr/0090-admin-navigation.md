---
status: accepted
---

# Admin navigation from server-derived capability

The Feedback, Waitlist, and Restore pages were deliberately unlinked. Cam is
Dotflowy's sole admin and had to remember their URLs. Admins now get one
**Admin** entry; everyone else sees no change. This amends
[0072](./0072-split-header-view-and-app-menus.md).

## Decisions

1. **One entry, beside Settings.** The App menu (desktop avatar) and the phone
   More menu's Account and help section share `AppMenuItems`, so one **Admin**
   row below Settings covers both. Find lists one **Open admin** command. There
   is no shortcut, dock tab, submenu, or command for a destructive operation.
2. **`/admin` is a list of links.** Feedback inbox, Pro codes, Waitlist, Restore a user,
   in that order, with Restore marked destructive. Opening a link never changes
   data; Restore keeps its own review step. Each admin page starts with the
   same **Admin** and **Back to outline** links, which wrap on phones. Pro codes
   generates standalone 30-day thank-you codes, records an internal reason,
   and shows creation, expiry and first-redemption history (0087).
3. **The server supplies the capability.** `GET /api/account-capabilities`
   returns `{ admin }` from `isAdminSession` for the current session, `private,
no-store`, and 401 without a session. The client never names an admin
   email or ID, and admin status never derives from membership or the owner
   bridge. `AdminAccessProvider` (inside the auth gate) shares the answer with
   the menus, Find, and the `/admin` layout route. It is not persisted, and it
   revalidates on window focus. An account switch already reloads the page
   (0011).
4. **Pages render only after a positive answer.** The `/admin` layout route
   renders nothing while checking, **Not found.** when denied, and a retry
   message when the first check fails, so a non-admin never sees the Restore
   form. A failed revalidation keeps the last answer, so a network blip cannot
   wipe an open page's drafts.
5. **APIs still authorize every request.** The capability is a display hint.
   Every admin route keeps its own `isAdminSession` check and 404s for
   non-admins, so stale tabs, edited browser state, and direct calls stay
   refused.

6. **Pin the admin by account ID.** `wrangler.jsonc` sets `ADMIN_USER_IDS` to
   Cam's Better Auth `user.id`, read from production D1, where exactly one
   verified account has his email. `isAdminSession` then ignores
   `ADMIN_EMAILS`, so admin no longer follows an email address. Cam approved
   this. Local admin testing sets a local ID in `.dev.vars`.

Invite, announce, and off-site backup tools stay script- or API-only.
