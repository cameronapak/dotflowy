/// <reference types="@cloudflare/workers-types" />

/**
 * Better Auth: the app's identity layer. Email + password self-serve signup,
 * sessions in D1. Better Auth's `user` table IS the global identity store and
 * `user.id` is the stable, permanent key the Worker routes each user's outline
 * Durable Object by (see resolveUserId in index.ts). See docs/adr/0011-the-auth-gate.md.
 *
 * Why a per-request factory and not a module singleton: the D1 binding only
 * exists inside `fetch(request, env)`, so auth MUST be constructed from `env`
 * per request. Identity lives in D1; the outline itself lives in the per-user
 * Durable Object.
 */

import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha, mcp } from "better-auth/plugins";
import Stripe from "stripe";

import type { UserOutlineDO } from "./outline-do";

import {
  cancelActiveSubscriptions,
  deleteResidualUserRows,
  isOwnerAccount,
} from "./account-deletion";
import { sendEmail } from "./email";
import { isSignupOpen, matchesSharedInviteCode } from "./identity";
import { isRedeemableInvite, normalizeEmail, redeemInvite } from "./invites";
import { FOUNDING_SEAT_LIMIT, countFoundingSeats } from "./plan";

/** The slice of the Worker env Better Auth needs. */
export interface AuthEnv {
  DB: D1Database;
  /** The `send_email` binding (worker/email.ts). Optional: absent in plain
   *  local dev, where sends fall back to console logging. */
  EMAIL?: SendEmail;
  /** Signing secret. Set in prod via `wrangler secret put BETTER_AUTH_SECRET`,
   *  locally via `.dev.vars`. Better Auth fails closed without it in prod. */
  BETTER_AUTH_SECRET?: string;
  /** The deployment's public origin (e.g. https://dotflowy.example.com), used
   *  for cookie/redirect URLs and as a trusted origin. Unset in local dev. */
  BETTER_AUTH_URL?: string;
  /** Comma-separated invite codes gating signup (alpha is invite-only). Unset
   *  or empty = signup CLOSED — nobody can create an account. Rotate the
   *  secret to revoke every outstanding code at once. */
  INVITE_CODES?: string;
  /** Open-signup switch (#293). The literal "true" skips the invite requirement
   *  on /sign-up/email (Turnstile still gates it); unset/anything-else keeps
   *  signup invite-only. Fail-closed — see isSignupOpen. Ships UNSET. */
  SIGNUP_OPEN?: string;
  /** Cloudflare Turnstile SECRET key (#293). When set, the captcha plugin is
   *  registered and enforces a Turnstile token on /sign-up/email +
   *  /request-password-reset. Unset = the plugin isn't registered (local dev
   *  and any deploy without a key work exactly as before — the optional-secrets
   *  pattern shared with Google/Stripe). Set via `wrangler secret put`. */
  TURNSTILE_SECRET_KEY?: string;
  /** Google OAuth client for "Sign in with Google". Both unset = the provider
   *  simply isn't registered (sign-in button errors with provider-not-found;
   *  local dev works fine without them). Set via `wrangler secret put`. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Stripe API key (`sk_test_…` locally, `sk_live_…` in prod via
   *  `wrangler secret put STRIPE_SECRET_KEY`). Unset = billing endpoints exist
   *  but every Stripe call fails; sign-in/sync/MCP are untouched. */
  STRIPE_SECRET_KEY?: string;
  /** Webhook signing secret for /api/auth/stripe/webhook (`whsec_…`). From the
   *  dashboard endpoint in prod, `stripe listen` locally. Unset = webhook
   *  signature verification fails closed. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The per-user outline Durable Object namespace. Self-serve account deletion
   *  (ticket #224) reaches the caller's DO through this to wipe their outline as
   *  part of the delete lifecycle — the same binding worker/index.ts routes
   *  /api/nodes through, resolved here from the authenticated session's user.id
   *  (never a client-supplied id; the DO trust boundary, ADR 0014). */
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  /** The owner's Better Auth `user.id`. When set, that one account routes to the
   *  constant 'default' DO (worker/index.ts resolveUserId); self-serve deletion
   *  refuses it (docs/adr/0051). */
  OWNER_USER_ID?: string;
}

/**
 * Stripe Price lookup keys — the stable, environment-independent handle the
 * plugin resolves to a live price id at checkout time. The Prices created in
 * the Stripe dashboard (test AND live mode) MUST carry these lookup keys;
 * that's the whole coupling, no price-id env vars. Pricing per #152:
 * unlimited $5/mo · $48/yr; founding $99 · 3-year interval (Stripe's max —
 * the price itself is `recurring: { interval: 'year', interval_count: 3 }`).
 */
export const STRIPE_LOOKUP_KEYS = {
  unlimitedMonthly: "dotflowy_unlimited_monthly",
  unlimitedAnnual: "dotflowy_unlimited_annual",
  founding: "dotflowy_founding",
} as const;

/** The password-reset email, as an HTML + plain-text pair (both always sent —
 *  spam score + client compatibility). Two templates is below the bar for a
 *  template system; inline strings are the system. */
function resetPasswordEmail(url: string) {
  return {
    subject: "Reset your Dotflowy password",
    text: `Reset your Dotflowy password:\n\n${url}\n\nThis link expires in 1 hour. If you didn't ask for a reset, you can ignore this email — your password is unchanged.`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; font-weight: 600;">Reset your Dotflowy password</h1>
  <p style="font-size: 14px; color: #444; line-height: 1.5;">Someone (hopefully you) asked to reset the password for this email address.</p>
  <p style="margin: 24px 0;"><a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Choose a new password</a></p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">This link expires in 1 hour. If you didn't ask for a reset, ignore this email — your password is unchanged.</p>
</div>`,
  };
}

/** The email-verification message (HTML + text; both always sent, same posture
 *  as the reset email). Confirms the address a signup used before the account
 *  can sign in (#293). */
function verifyEmail(url: string) {
  return {
    subject: "Confirm your Dotflowy email",
    text: `Confirm your email to finish setting up Dotflowy:\n\n${url}\n\nIf you didn't create a Dotflowy account, you can ignore this email.`,
    html: `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; font-weight: 600;">Confirm your email</h1>
  <p style="font-size: 14px; color: #444; line-height: 1.5;">One more step to finish setting up your Dotflowy account.</p>
  <p style="margin: 24px 0;"><a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; font-size: 14px; padding: 10px 16px; border-radius: 6px;">Confirm email</a></p>
  <p style="font-size: 13px; color: #666; line-height: 1.5;">If you didn't create a Dotflowy account, ignore this email.</p>
</div>`,
  };
}

export function createAuth(
  env: AuthEnv,
  requestOrigin?: string,
  executionCtx?: ExecutionContext,
) {
  // Fail closed, explicitly (#232). The secret signs sessions + reset tokens;
  // it's optional-typed only because the binding is absent in some tooling.
  // "Better Auth fails closed without it" was an unverified claim — assert it
  // here so a misconfigured deploy 500s loudly at construction instead of
  // silently signing with a missing/empty secret. `bun run setup` writes it to
  // .dev.vars; prod sets it via `wrangler secret put BETTER_AUTH_SECRET`.
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.trim() === "") {
    throw new Error(
      "BETTER_AUTH_SECRET is required (unset or empty). Set it via `wrangler secret put BETTER_AUTH_SECRET` in prod, or run `bun run setup` locally.",
    );
  }
  return betterAuth({
    // Better Auth accepts a D1 binding directly (kysely under the hood).
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // Most of Better Auth infers the base URL from the request, but the mcp
    // plugin's OAuth discovery metadata REQUIRES an explicit one (it's the
    // OAuth `issuer`). Prod pins it via BETTER_AUTH_URL; otherwise fall back
    // to the calling request's origin (correct on any deployment + local dev).
    baseURL: env.BETTER_AUTH_URL ?? requestOrigin,
    emailAndPassword: {
      enabled: true,
      // ON now that signup can open up (#293). With open signup an unverified
      // address is a real hole (anyone could sign up as anyone), so an account
      // can't create a session until its email is confirmed. Existing alpha
      // accounts are grandfathered verified by migration 0008 so none is locked
      // out. Flipping this on ALSO makes implicit Google linking start working
      // for verified accounts (see the accountLinking note below and ADR 0011).
      requireEmailVerification: true,
      // The delivery function password reset was missing until #169. Better
      // Auth AWAITS this callback (no backgroundTasks handler configured), so
      // it must return fast and uniformly: the send rides ctx.waitUntil —
      // registered, not awaited — which (a) keeps the response time identical
      // whether or not the email exists (no enumeration side channel; the
      // endpoint already fakes the token work for unknown emails) and (b)
      // keeps the Workers isolate alive until the send finishes, which a bare
      // dangling promise would NOT survive. sendEmail itself never throws.
      sendResetPassword: async ({ user, url }) => {
        const send = sendEmail(env, {
          to: user.email,
          ...resetPasswordEmail(url),
        });
        if (executionCtx) executionCtx.waitUntil(send);
        else await send;
      },
      // A reset is the "my password leaked" move: kill every existing session
      // so a stolen one dies with the old password.
      revokeSessionsOnPasswordReset: true,
    },
    // Email verification (#293). `sendOnSignUp` is left at its default
    // (undefined = follow requireEmailVerification), so a verification email
    // goes out on every signup now that verification is required. Delivery
    // rides the ONE email seam (worker/email.ts) on ctx.waitUntil — same
    // reasoning as sendResetPassword above: Better Auth awaits this callback,
    // so registering the send (not awaiting it) keeps the response fast and the
    // isolate alive until the send finishes (a bare dangling promise would die
    // with the isolate). sendEmail itself never throws.
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        const send = sendEmail(env, {
          to: user.email,
          ...verifyEmail(url),
        });
        if (executionCtx) executionCtx.waitUntil(send);
        else await send;
      },
    },
    // Self-serve account deletion (ticket #224 / docs/adr/0051). Confirmed
    // client-side by re-entering the password (`authClient.deleteUser({password})`)
    // — every account has one (email+password is the only signup path), so the
    // password path always works even for Google-linked accounts. Email
    // verification is deliberately NOT wired (`sendDeleteAccountVerification`
    // absent): verification is off for beta (ADR 0011), and the fresh-password
    // check already proves it's the account owner at the keyboard.
    user: {
      deleteUser: {
        enabled: true,
        // beforeDelete runs while the account still exists and BEFORE Better
        // Auth reports success — the property the teardown needs: the endpoint
        // must never answer "deleted" unless Stripe is already cancelled and
        // the outline is already wiped (afterDelete also has env + user, but a
        // failure there happens AFTER the success response — too late to keep
        // the promise). A throw here ABORTS the deletion with nothing
        // destroyed — exactly what we want if Stripe cancellation fails (a
        // paying subscription must never outlive its account). Order matters:
        // guard → Stripe (external, must succeed) → DO wipe (irreversible,
        // last).
        beforeDelete: async (user) => {
          if (isOwnerAccount(user.id, env.OWNER_USER_ID)) {
            throw new APIError("FORBIDDEN", {
              message:
                "This account can't be deleted from the app. Contact support.",
            });
          }
          // Throws on a real Stripe failure → deletion aborts, DO untouched.
          // Also clears the D1 subscription row (here in beforeDelete, not the
          // best-effort afterDelete sweep: deleteUser doesn't cascade the
          // Stripe plugin's table, and a failed afterDelete would orphan it).
          await cancelActiveSubscriptions(env, user.id);
          // Non-owner, so resolveUserId(user.id) === user.id: the caller's own
          // DO, resolved from the authenticated user.id (never client input).
          const stub = env.USER_OUTLINE.get(
            env.USER_OUTLINE.idFromName(user.id),
          );
          await stub.wipe();
        },
        // afterDelete runs once the identity rows are gone. Better Auth's core
        // deletes user/session/account; the mcp OAuth rows and the email-keyed
        // waitlist + invites rows are cleaned here. Best-effort AND non-fatal
        // (ADR 0051): the account is already deleted, so a failure here must
        // be logged (Workers Logs + Sentry pick up console.error), never
        // surfaced as an error on a deletion that already happened.
        afterDelete: async (user) => {
          try {
            await deleteResidualUserRows(env.DB, user.id, user.email);
          } catch (err) {
            console.error("account-deletion residual-row scrub failed", err);
          }
        },
      },
    },
    // "Sign in with Google" — sign-IN only. `disableSignUp: true` is the same
    // invite gate as the /sign-up/email hook, expressed for OAuth: a Google
    // callback with no matching account is rejected server-side instead of
    // creating a user, so the social path can't bypass INVITE_CODES. It must
    // be `disableSignUp` (hard), NOT `disableImplicitSignUp` — the latter is
    // waived by a client-supplied `requestSignUp: true`, which would reopen
    // the bypass. Registered only when both secrets exist so a bare local dev
    // env still constructs auth cleanly.
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              disableSignUp: true,
              prompt: "select_account",
            },
          }
        : undefined,
    // Account-linking policy (how an existing email+password user gets Google
    // on the same account — same `user.id`, hence the same outline DO). EXPLICIT
    // linking via `linkSocial` while signed in (the "Connect Google" menu item)
    // always works. IMPLICIT linking on a signed-out Google sign-in is left at
    // Better Auth's default: it refuses to link into a local account whose email
    // is UNVERIFIED (`requireLocalEmailVerified` defaults true), because an
    // attacker who pre-registered the victim's email could otherwise capture the
    // victim's Google identity. Now that verification is ON (#293) and existing
    // accounts are grandfathered verified (migration 0008), a VERIFIED account's
    // signed-out Google sign-in links implicitly — the gate lifts for exactly
    // the accounts we can trust, no code change (verified from source: a
    // trustedProviders match + `emailVerified` true satisfies both clauses of
    // link-account.mjs's refusal check). A still-unverified brand-new signup
    // remains refused until it confirms — surfaces as ?error=account_not_linked,
    // which the AuthScreen points at the explicit path. (Don't reach for the
    // deprecated `requireLocalEmailVerified: false`; it becomes unconditional
    // next minor.)
    account: {
      accountLinking: {
        // Google reports emailVerified, so this is belt-and-braces today; it
        // matters once local emails get verified (then implicit linking works).
        trustedProviders: ["google"],
        // Explicit link only: the live session already proves account
        // ownership, so the connected Google identity may use a different
        // address. Does NOT loosen the signed-out path (that lookup is
        // email-keyed, so a different-address Google sign-in just finds no
        // account and hits disableSignUp).
        allowDifferentEmails: true,
      },
    },
    // Dev serves the SPA from Vite (:3000) and proxies /api to the Worker, so
    // a sign-in request's Origin is the Vite origin, not the Worker's. Trust
    // the local dev origins explicitly; prod is covered by baseURL. e2e (:3210)
    // mocks /api/auth, so it never reaches this, but trusting it costs nothing.
    trustedOrigins: ["http://localhost:3000", "http://localhost:3210"],
    // Signup gate: /sign-up/email is the ONLY account-creation path (the mcp
    // plugin's dynamic registration creates OAuth clients, not users), so gating
    // it here controls signup entirely. Server-side on purpose — hiding the
    // signup UI wouldn't stop a direct POST to the endpoint.
    //
    // Three states (#293), all decided here except the captcha:
    //  - OPEN (SIGNUP_OPEN === "true"): the invite requirement is SKIPPED. The
    //    Turnstile plugin (registered below) still gates the endpoint, so signup
    //    is human-verified, not code-gated. A supplied invite is still redeemed
    //    harmlessly by the after-hook.
    //  - INVITE (default): the request must carry a valid code (below).
    //  - CLOSED: the invite state with no codes configured — fails closed.
    //
    // A signup is accepted when the supplied code is EITHER:
    //  (a) a per-email, single-use invite bound to this exact email (#251 —
    //      minted from the waitlist, redeemed here), OR
    //  (b) in the shared INVITE_CODES secret (kept as an admin/testing backdoor).
    // An unset INVITE_CODES and no matching per-email invite fails CLOSED: no
    // codes, no signups; sign-in is untouched.
    //
    // Redemption is split across before/after ON PURPOSE. `before` only
    // VALIDATES (a read) so a valid code isn't burned when account creation then
    // fails downstream (duplicate email, weak password). `after` stamps the code
    // redeemed — but only on a real success (the endpoint sets `returned` to an
    // APIError on failure), via a conditional UPDATE that can't double-burn. The
    // email uniqueness of the user table already stops two accounts sharing one
    // email-bound code, so this is belt-and-braces.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        // Open signup: no invite required (Turnstile already gated this request
        // in the captcha plugin's onRequest). Accept and let the after-hook
        // redeem any invite that happened to ride along.
        if (isSignupOpen(env)) return;
        const supplied =
          typeof ctx.body?.inviteCode === "string"
            ? ctx.body.inviteCode.trim()
            : "";
        const email =
          typeof ctx.body?.email === "string"
            ? normalizeEmail(ctx.body.email)
            : "";
        // (a) A per-email single-use invite bound to this address.
        if (
          supplied &&
          email &&
          (await isRedeemableInvite(env, email, supplied))
        ) {
          return; // valid; the after-hook stamps it once the account exists
        }
        // (b) The shared INVITE_CODES backdoor.
        if (matchesSharedInviteCode(supplied, env.INVITE_CODES)) return;
        throw new APIError("FORBIDDEN", {
          message:
            "Dotflowy is invite-only during alpha. Ask for an invite code, or join the waitlist.",
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        // Only burn the code on a genuine account creation. On failure the
        // endpoint's result — surfaced here as `ctx.context.returned` — is an
        // APIError, so we leave the invite unredeemed and reusable.
        if (ctx.context.returned instanceof APIError) return;
        const supplied =
          typeof ctx.body?.inviteCode === "string"
            ? ctx.body.inviteCode.trim()
            : "";
        const email =
          typeof ctx.body?.email === "string"
            ? normalizeEmail(ctx.body.email)
            : "";
        // No-op when `supplied` was the INVITE_CODES backdoor (no invites row).
        if (supplied && email) await redeemInvite(env, email, supplied);
      }),
    },
    // Billing (issue #162): the @better-auth/stripe plugin owns the whole
    // Stripe surface — checkout via `subscription.upgrade()`, the webhook at
    // /api/auth/stripe/webhook (inside the /api/auth/* prefix index.ts already
    // routes BEFORE the session gate — zero new routing), and the D1
    // `subscription` table (migration 0006) that worker/plan.ts reads for
    // entitlements. Nothing calls Stripe on the request path.
    //
    // The plugin is unconditional so `Auth`'s inferred type (and the D1
    // schema) never depends on which secrets are set; a missing key only
    // breaks the billing endpoints themselves (stripe-node throws at call
    // time, not construction — the placeholder key is never sent anywhere
    // except a failing Stripe call on a box without .dev.vars keys).
    //
    // stripe-node v22 ships workerd export conditions, so `new Stripe(key)`
    // auto-selects the fetch HTTP client + SubtleCrypto webhook verification.
    //
    // OAuth 2.1 authorization server for the MCP endpoint (/mcp): PKCE
    // authorization-code flow with dynamic client registration, tokens in D1
    // (migration 0004). The SPA's AuthScreen doubles as the login page — the
    // authorize endpoint stashes the OAuth query in a signed cookie, sends the
    // signed-out user to `/`, and resumes the flow after sign-in (the plugin's
    // after-hook plus AuthScreen's explicit authorize-redirect fallback).
    // See docs/adr/0026-agent-native-mcp-server.md.
    plugins: [
      // Cloudflare Turnstile (#293), registered ONLY when the secret is set —
      // the optional-secrets pattern (Google/Stripe): no key locally or on a
      // fork = the plugin isn't registered = signup/reset behave exactly as
      // before. It gates EXACTLY /sign-up/email and /request-password-reset (the
      // real client endpoint; /forget-password is its legacy alias) — NOT
      // sign-in, which must stay token-free so the MCP OAuth resume path and
      // Better Auth's own rate limiting carry the brute-force load. The client
      // sends the token in the `x-captcha-response` header (the plugin's
      // onRequest reads exactly that). Fails closed: a missing/invalid token is
      // a 400 before the endpoint runs.
      ...(env.TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: ["/sign-up/email", "/request-password-reset"],
            }),
          ]
        : []),
      mcp({ loginPage: "/" }),
      stripe({
        stripeClient: new Stripe(
          env.STRIPE_SECRET_KEY ?? "sk_test_placeholder",
        ),
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
        // No Stripe customer until first checkout: alpha users need no
        // backfill, and the free tier is the absence of a subscription row.
        // The plugin creates the customer lazily at first `upgrade()`.
        createCustomerOnSignUp: false,
        subscription: {
          enabled: true,
          // Both plans are ALWAYS listed. Don't gate the founding cap by
          // withholding it from an async `plans` fn: webhooks and
          // `subscription.list()` resolve a subscription's plan from this
          // same list, so a withheld plan would break state updates for the
          // 50 people who already bought it. The cap gates checkout below.
          plans: [
            {
              name: "unlimited",
              lookupKey: STRIPE_LOOKUP_KEYS.unlimitedMonthly,
              annualDiscountLookupKey: STRIPE_LOOKUP_KEYS.unlimitedAnnual,
            },
            {
              name: "founding",
              lookupKey: STRIPE_LOOKUP_KEYS.founding,
            },
          ],
          // The founding 50-seat cap, enforced server-side at the moment a
          // checkout session would be created (hiding the pricing card is
          // #171's UX; this is the wall a direct POST hits). Runs only on
          // /subscription/upgrade, never on the request path. At the boundary
          // a race can oversell by a seat — that's a refund-one-customer
          // problem, per #162.
          getCheckoutSessionParams: async ({ plan }) => {
            if (
              plan.name === "founding" &&
              (await countFoundingSeats(env.DB)) >= FOUNDING_SEAT_LIMIT
            ) {
              throw new APIError("FORBIDDEN", {
                message:
                  "All founding seats are taken. The unlimited plan is available.",
              });
            }
            return {};
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
