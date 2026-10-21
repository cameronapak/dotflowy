# Split header overflow into View and App menus

The single More menu mixed outline actions with account and help links. Split
it into a sliders-triggered **View menu** and an avatar-triggered **App menu**.
Their accessible names are **View options** and **Account and help**. Keep
the existing header controls, including Cmd+K on narrow screens; breadcrumbs
truncate before controls disappear. Both triggers stay ghost-only, following
[ADR 0050](./0050-header-toggle-button-states.md).

The View menu groups Collapse all, Expand all, and Copy as Markdown above a
separator, then Show completed, Spotlight mode, and plugin display toggles.
Actions keep their current zoom-root scope. The App menu contains Settings,
What's new (with unread count), Report a bug, GitHub, Terms, Privacy Policy,
then Sign out. The unread dot moves to the avatar. Legal links remain normal
menu rows, not small footer links, for keyboard navigation and touch targets.
Both menus use anchored desktop menus and sheets below 768px, as specified in
[ADR 0066](./0066-narrow-screen-menu-drawers.md).

Undo and Redo stay in Cmd+K, keyboard shortcuts, and the mobile editing bar,
not either menu. Apple Shortcut setup stays in Settings > Experimental.
A compact single menu and customizable pinning add complexity without this
clear separation, so neither is part of this change.

The avatar uses the session's image, then the email initial, then a user icon.
Missing or broken photos use the same fallback. Requests send no referrer.
Google linking copies the provider's name and image through Better Auth's
`updateUserInfoOnLink`, without changing the local email or verification state.
Previously linked accounts can reconnect Google to populate a missing photo.
There is no backfill or new profile field. Do not enable
`overrideUserInfoOnSignIn`: in Better Auth 1.6.33 it also overwrites the local
email, including after a different-email explicit link. Signup and linking
eligibility remain unchanged; the name update on linking is accepted.
