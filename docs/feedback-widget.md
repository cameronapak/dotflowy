# Amp feedback widget

The [Amp feedback widget](https://ampcode.com/docs/feedback-widget) loads only
for one server-verified Dotflowy account. It stays off until both Worker settings
below are configured. No real client ID, reviewer ID, or allowed origin is
committed here. Enabling Amp and deploying are separate operational steps.

## Existing trust boundary

[ADR 0031](./adr/0031-two-lane-plugin-trust.md) records the approved owner-only
exception to its third-party-script restriction. Cameron chose live review on
his own account rather than requiring a synthetic-data preview. This is not
permission to load third-party scripts for other users or to add runtime plugins.

Amp's panel is an iframe, but the script that selects page elements runs in the
host document. Treat it as trusted third-party code with access to the DOM,
JavaScript-readable storage, and same-origin requests. HttpOnly cookies prevent
reading the cookie value, not making authenticated requests. Neither a hidden
button nor `?amp` is an access control or a script sandbox.

Use synthetic content for initial testing. During live review, do not select
private notes or put credentials in comments or page URLs. Dotflowy's MCP spoiler
redaction and Sentry scrubbing do not apply to the widget's DOM access. Amp's
docs say the agent receives the selected element, comment, and page address;
they do not establish a comprehensive redaction or data-minimization guarantee.

## How the integration works

The signed-in editor requests `GET /api/feedback-widget`. The Worker validates
its configuration and the Better Auth session. Only an exact match to
`AMP_FEEDBACK_USER_ID` returns `{clientId, userId}`. Everyone else, including
signed-out visitors and other admins, gets 404. There is no email fallback.
All responses, including errors, use `Cache-Control: private, no-store`.

The browser validates the response against the shared Effect Schema, checks
that it belongs to the currently mounted account, and loads the async script
from the fixed `https://ampcode.com/w/` host. The client ID permits only the
`client_` prefix followed by alphanumeric characters, never a URL or path.
The public shell contains no widget script tag. Auth and legal pages do not
mount the loader; the demo backend does not provide widget configuration.

The loader mounts once with the authenticated editor, not per node or route.
Failed, malformed, or timed-out configuration requests leave the widget off.
Leaving that authenticated surface after script insertion forces a full
document reload, including session loss or account changes when the client
observes them. Pending requests are cancelled on unmount. Removing a script
tag alone would not remove its listeners, iframe, or code. Existing sign-out
and account-switch paths also retain their full-page navigation.

Amp controls button activation with `?amp` and its remembered preference. Once
configured, the script loads for the owner even when the button is hidden;
other accounts' ordinary app sessions never load it. This controls the app's
automatic loading, not what someone can execute manually in their own browser.

### Keyboard shortcut priority

Amp uses Cmd+Period on macOS and Ctrl+Period elsewhere to show or hide its
button. Its window-capture listener stops the event before node keymaps run.
The loader installs an earlier capture listener so an enabled, focused node
editor keeps that chord for zooming into its node. It invokes the node keymap's
registered zoom action, preserving mirror targets and menu gating. Other keys
and non-node surfaces retain Amp's behavior. You can still click the review
button or right-click it and choose **Hide Review Button**. Open `?amp` to show
it again without using the shortcut.

## Public configuration and secrets

The client ID in Amp's script tag and the allowed app origin are public
identifiers. Anyone can inspect or copy them, including readers of this public
repository. They are not bearer credentials and do not grant thread access.
Configure these optional Worker settings, not `VITE_*` build variables:

| Setting                  | Value                                                   | Sensitive?                                           |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| `AMP_FEEDBACK_USER_ID`   | The stable Better Auth ID of the approved owner account | Server authorization configuration, not a credential |
| `AMP_FEEDBACK_CLIENT_ID` | The `client_...` ID from Amp's generated widget tag     | Public identifier                                    |

Neither setting inherits `ADMIN_EMAILS`, `ADMIN_USER_IDS`, or `OWNER_USER_ID`.
Do not change the outline's owner-continuity mapping to enable feedback.
Missing or malformed configuration disables the widget. Local dev and forks
stay disabled unless their operators explicitly configure both values.

Do not put Amp access tokens, OAuth client secrets, GitHub tokens, Cloudflare
tokens, production auth secrets, or database credentials in client configuration,
HTML, or version control. The documented widget integration needs none of them.
Sign-in and consent happen with Amp; Dotflowy's account session does not grant
Amp permissions. Review the project's app consent before approving it.

## Setup with configuration and deployment approval

1. Verify the Amp project maps to `cameronapak/dotflowy` and belongs to a
   workspace. Personal projects cannot use this widget. Audit workspace members:
   every member who can start project threads can send widget feedback.
2. Have the project creator or a workspace admin enable **Feedback Widget** in
   project settings. Inspect any workspace organization conversion prompt before
   accepting it; Amp documents that turning the widget off does not reverse
   that conversion. Copy the generated script tag's public client ID.
3. Confirm the stable Better Auth user ID belonging to the owner's verified
   account, then configure both Worker settings. Do not infer the ID from an
   email, copy an Amp user ID, or pin a newly registered account without checking
   its ownership. Use `.dev.vars` locally; deployment-specific Worker vars can
   hold these non-secret values. For production, use `wrangler secret put` for
   each setting so per-deployment configuration stays outside version control
   and survives normal deployments. This storage choice does not make these
   identifiers credentials. Deploy only after approval.
4. Add only the exact HTTPS app origin under **Allowed Origins**. Origins
   contain scheme, host, and port, not a path; `/demo` cannot scope permission.
   Do not add production, forks, or transient previews automatically. Local
   loopback HTTP origins are supported, but add them only when needed.
5. If a CSP restricts scripts or frames, permit `https://ampcode.com`
   in `script-src` and `frame-src` without discarding other restrictions.
   Dotflowy's Worker currently sets `frame-ancestors`, which governs who may
   frame Dotflowy, not which scripts or frames it may load. Preserve that policy.
6. Sign in to Dotflowy as the pinned owner, open it with `?amp`, select a
   nonsensitive element, and sign in to Amp.
   With approval to create a test thread, send feedback and confirm that it
   opens in the intended repository project. Check a signed-in nonmember gets
   **Access Required** and an unlisted origin cannot send. Check another
   Dotflowy account and a signed-out session make no widget script request,
   even with `?amp` or a remembered preference. Confirm logout destroys the
   document that loaded the script. Use disposable accounts for initial checks.

## Abuse controls and future updates

Amp documents server-side origin checks and project permissions for sending
feedback. Public repository access, a copied client ID, or revealing the button
does not confer permission. Origin checks do not replace authentication, and
an allowed origin is not an agent-execution credential. The docs do not specify
widget rate limits or quotas; do not claim they protect cost or availability.
Keep membership narrow, review new threads and usage, and remove unused origins.
Feedback content and selected DOM remain untrusted input for the coding agent.

Each send starts a new thread in an orb with a repository copy, not live data.
Give the expected behavior and a synthetic reproduction. Review the diff and
tests there, then authorize the normal delivery path separately. Feedback does
not itself deploy a fix; once an authorized change reaches `main`, Dotflowy's
existing release/deploy workflow can run. Do not give feedback threads extra
production secrets or bypass existing checks for convenience.

To disable automatic loading, unset either Worker setting and apply the change;
already-open documents retain loaded code until they reload. To withdraw Amp
submission access for that site, remove its allowed origin. Turning
off the project widget stops it across sites and revokes its sign-ins. Individual
reviewers can revoke the app in Amp's **Security > Authorized Apps**. Re-enabling
the widget creates a new client ID, so update the Worker configuration. Hiding
the review button is not revocation.
