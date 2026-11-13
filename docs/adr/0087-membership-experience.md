---
status: accepted
---

# Membership previews, welcome, and private feedback

Pro and Founding include additional color themes, MCP/CLI connections,
and private ideas/questions. Bug reporting stays free. Put offers where a user
asks for a paid feature, plus Plan & billing and the app menu, rather than
interrupting writing with repeated prompts. Mode and the default palette stay
free. Theme preview and the one launch exception are in [ADR 0082](./0082-color-themes.md).

The session-owned `/api/membership` projection shares one D1-backed plan across
Settings, menus, and commands. The Worker remains the authority for writes;
client state and checkout return URLs never grant access. Trialing and active
subscriptions retain the existing entitlement rule; canceled-at-period-end
subscriptions keep access while active.

The Stripe plugin's verified `onEvent` callback queues one welcome per Stripe
subscription in D1 after a paid checkout completion, including delayed-payment
success. Unlike its `onSubscriptionComplete` hook, `onEvent` propagates failures
as non-2xx responses so Stripe retries a failed receipt write or an out-of-order subscription
record. Reading a paid plan, returning from checkout, trialing, or receiving an
operator comp is not payment evidence. Renewals do not queue it. The dialog is offered until its account-scoped acknowledgment is
saved, then stays dismissed across devices; simultaneous open devices may both
see it before dismissal. A failed acknowledgment remains retryable. Pending and
canceled checkout returns never claim payment succeeded. The original preview
is not saved through the Stripe redirect: Choose a theme returns to Appearance,
where the new member can pick and save any palette.

Feedback goes to a private D1 inbox, not a public GitHub redirect or an external
service. `POST /api/feedback` attaches the unmodified session user ID and current
plan server-side. Bugs are open to all accounts, ideas/questions to paid plans;
free ideas can still be drafted publicly on GitHub. This keeps paid ideas easy
to identify without promising delivery or ranking them above security and
data-loss issues. A free account's feedback form links to Plan & billing for a
subscription and explains the extra weight given to subscriber ideas. Opening
plans keeps the unsent draft in memory; it does not submit feedback. App version
is included; browser details and a coarse route
category are opt-in. Never automatically attach outline content, screenshots,
full URLs, query strings, or node identifiers. Show a review before sending,
keep failed drafts in memory, and reuse an account-scoped idempotency key for
retries. A persistent rolling quota permits ten accepted reports per 24 hours;
retries don't count. Schema and streamed byte limits bound the input, and
expected errors never log report text.

`/admin/feedback` renders the admin-only `GET /api/admin/feedback` inbox, with
status, kind and plan-at-submission filters, newest first, up to 100 reports.
The UI starts with open reports; complete reports remain available in the status
filter. `POST /api/admin/feedback` marks a report complete, reopens it, or appends
an internal comment. Repeated completion keeps the original completion time;
reopening clears it. Stable comment IDs make retries safe, with changed content
or a different report rejected as a conflict. These actions use the same admin
allowlist as reads, check same-origin JSON requests, and return 404 to everyone
else, including the report's author. Internal comments are never customer replies
and never trigger emails. No assignments, public status tracker, or notifications
on completion are implied.

The inbox joins each reporter's current account email, with a mailto link and
an explicit Email reporter action. Only verified account addresses can receive
replies. Compose and review the fixed From, To, subject and message before
sending. The server checks that the reviewed recipient still matches the
account, never accepts an arbitrary sender or recipient, and sends only the
chosen message, Cam's signature and report reference. It never attaches the
original report or internal comments. Replies use `Dotflowy Support
<support@dotflowy.com>` with Reply-To `support@dotflowy.com`; verify this
receiving mailbox before enabling sends. Replies to that mailbox do not sync
back into the app.

Each deliberate send gets a durable unique ID before calling `worker/email.ts`.
Repeated IDs return history without resending, including concurrent requests or
an uncertain provider outcome. Await provider acceptance and also park the
promise on `ctx.waitUntil`. Store acceptance separately from delivery, which we
do not track. A failed or interrupted send stays unconfirmed, including a
provider acceptance whose database update failed. Unresolved sends display as
unconfirmed after two minutes; never retry them automatically. The admin can
check the same attempt's status, inspect provider logs, and deliberately compose
a new email. There is no retry queue or exactly-once delivery guarantee.

`FEEDBACK_REPLY_MODE` defaults to `disabled`. `simulate` exercises persistence
and history without invoking the provider; `send` requires the email binding.
Tracked deployment configuration stays disabled until the support sender and
receiving mailbox are verified. Local preview configuration uses simulate.

It is unlinked from customer chrome, like the other admin views. Reports,
internal comments, and reply history remain until account deletion (foreign-key
cascade) or an operator handles a removal request. Reply history records the
recipient address as sent, message, time, outcome and private provider ID so a
later account-email change does not rewrite correspondence. After a new report is durably accepted, send
an automatic receipt to the session account's email and a notification to
`FEEDBACK_NOTIFICATION_EMAIL`, independently of the admin allowlist. Both use
`worker/email.ts` on `ctx.waitUntil`. The notification includes kind, plan,
account email, reference, and a fixed private-inbox link. Neither email includes
report text, diagnostics, outline content, or the request URL. Receipts identify
themselves as automatic, include a reference and support address, and promise
neither a response time nor delivery of an idea.

Only the successful insert schedules sends; concurrent duplicates, conflicts,
rejected reports, and later retries never re-email. This deliberately follows
the existing invitation/announcement best-effort delivery policy: the shared
email seam logs a fixed failure message and returns an outcome without throwing, with no automatic retry or
bounce tracking. A failed or interrupted send never removes the durable report,
but can leave an email undelivered. The D1 inbox, not email, is the source of
truth. Durable delivery/retry would require a separate outbox and is not part of
this version. Local email bindings simulate sends, never deliver. Feedback rows
retain account ID, not a second stored email address.

The public recurring-plan name is **Dotflowy Pro**; Founding retains its name
and includes the same Pro benefits. Keep persisted `unlimited` plan identifiers,
Stripe price IDs, and `dotflowy_unlimited_*` lookup keys unchanged. This is a
display-name change, not a subscription migration. The existing Stripe Product
name should be renamed in place to Dotflowy Pro with separate approval; do not
replace its Prices or run the setup script to rename it. That script only
creates missing objects and does not rename existing ones.

Apply migrations 0017 through 0020 before deploying this code. This change does not
itself authorize a production migration, deployment, or modifying saved themes.
Local verification can seed subscription/receipt fixtures; that is not a real
Stripe payment. A Stripe test-mode checkout and signed webhook remain the
release check for the external payment flow.
