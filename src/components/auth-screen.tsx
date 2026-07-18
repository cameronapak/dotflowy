import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  hardReset,
  NETWORK_ERROR_MESSAGE,
  requestPasswordReset,
  signIn,
  signUp,
} from "../lib/auth-client";
import { consumeOAuthCallbackError } from "./oauth-callback-error";
import { Turnstile, type TurnstileHandle } from "./turnstile";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The unauthenticated view. Email + password, with a sign in / sign up toggle.
 * Rendered by the root AuthGate when there's no session; a successful auth
 * action updates the session store, which flips the gate to the editor. The
 * app shell is public (worker/index.ts), so this loads without a session.
 *
 * This screen doubles as the OAuth LOGIN PAGE for MCP clients (ADR 0026): the
 * authorize endpoint redirects a signed-out user here with the OAuth query
 * intact, so after a successful sign-in we hand the browser back to the
 * authorize endpoint (a top-level navigation — the code must reach the
 * client's redirect_uri as a real redirect, which a fetch can't deliver).
 */

/** The OAuth authorize query carried over from /api/auth/mcp/authorize, if
 *  this page load is an OAuth login hop rather than a plain visit. */
function pendingOAuthQuery(): string | null {
  const params = new URLSearchParams(window.location.search);
  const isAuthorize =
    params.has("client_id") &&
    params.has("redirect_uri") &&
    params.has("response_type");
  return isAuthorize ? params.toString() : null;
}

export function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Signup only: a second field so a mistyped password is caught before an
  // account is created (nobody can recover a password they never meant to set).
  const [confirmPassword, setConfirmPassword] = useState("");
  // Gate the mismatch message so it doesn't fire on the first keystroke — shown
  // once the field has been blurred or a submit was attempted.
  const [confirmTouched, setConfirmTouched] = useState(false);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Non-error status line (e.g. "account created, confirm your email"). Shown
  // where the error would show, in muted styling instead of destructive.
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Alpha is invite-only (the gate is server-side in worker/auth.ts); people
  // without a code leave their email on the waitlist instead.
  const [waitlist, setWaitlist] = useState<"idle" | "busy" | "done">("idle");
  // Forgot-password confirmation. Better Auth answers 200 whether or not the
  // email has an account (non-enumerable, same posture as the waitlist), so
  // this is the only success signal there is.
  const [resetSent, setResetSent] = useState(false);
  // Signup config from the public GET /api/auth-config (#293): whether signup
  // is OPEN (hide the invite field) and the PUBLIC Turnstile site key (render
  // the widget). null until loaded; default to the gated shape so we never
  // flash an open form for a gated deploy.
  const [signupOpen, setSignupOpen] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  // The solved Turnstile token, sent in the x-captcha-response header. Cleared
  // on mode switch and on submit failure (tokens are single-use).
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);

  const isSignup = mode === "signup";
  const isForgot = mode === "forgot";
  // Only compare once both fields have content, so the message never shows on
  // the very first character typed into the confirm field.
  const passwordsMismatch =
    password.length > 0 &&
    confirmPassword.length > 0 &&
    password !== confirmPassword;
  const showConfirmError = isSignup && confirmTouched && passwordsMismatch;
  // Turnstile guards signup + password reset (never sign-in). Only relevant
  // when the deploy configured a site key.
  const captchaMode = isSignup || isForgot;
  const captchaRequired = captchaMode && turnstileSiteKey !== null;

  // Shared Turnstile plumbing for the two gated submits (signup + forgot):
  // block until solved, ship the token in the header the captcha plugin reads,
  // and re-challenge after a failed attempt (tokens are single-use).
  function captchaBlocked(): boolean {
    if (captchaRequired && !captchaToken) {
      setError("Please complete the verification.");
      return true;
    }
    return false;
  }
  function captchaHeaders(): Record<string, string> | undefined {
    return captchaToken ? { "x-captcha-response": captchaToken } : undefined;
  }
  function resetCaptcha() {
    turnstileRef.current?.reset();
  }

  // A failed Google round trip lands back here with ?error=… — show it where
  // a form error would show. Only a truthy result sets state, so Strict
  // Mode's second effect run (which sees the already-stripped URL) is a no-op.
  useEffect(() => {
    const message = consumeOAuthCallbackError();
    if (message) setError(message);
  }, []);

  // Load the public signup config once. On failure we keep the gated defaults
  // (invite required, no widget) — the safe fallback if the endpoint is down.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth-config")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (cfg: { signupOpen?: boolean; turnstileSiteKey?: string } | null) => {
          if (cancelled || !cfg) return;
          setSignupOpen(Boolean(cfg.signupOpen));
          setTurnstileSiteKey(cfg.turnstileSiteKey ?? null);
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onGoogle() {
    setError(null);
    setBusy(true);
    const oauthQuery = pendingOAuthQuery();
    try {
      // The client navigates to Google on success (top-level), so the whole
      // flow is navigation-based: the OAuth callback's redirect is a fresh
      // page load, which is the hardReset teardown by construction. On an
      // MCP OAuth hop, the callbackURL IS the authorize resume — the same
      // top-level navigation the email path does by hand below.
      const res = await signIn.social({
        provider: "google",
        callbackURL: oauthQuery
          ? `/api/auth/mcp/authorize?${oauthQuery}`
          : window.location.href,
        // Land failures back on this screen (keeps any OAuth query intact).
        errorCallbackURL: window.location.href,
      });
      if (res.error) {
        setError(res.error.message ?? "Couldn't start Google sign-in.");
        setBusy(false);
      }
      // No error: the page is navigating away — keep `busy` true.
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setBusy(false);
    }
  }

  async function onForgot() {
    setError(null);
    if (captchaBlocked()) return;
    setBusy(true);
    try {
      // The emailed link round-trips through /api/auth/reset-password/:token,
      // which validates and redirects to this page with ?token= (or ?error=).
      const headers = captchaHeaders();
      const res = await requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
        fetchOptions: headers ? { headers } : undefined,
      });
      if (res.error) {
        setError(res.error.message ?? "Something went wrong. Try again.");
        resetCaptcha();
      } else {
        setResetSent(true);
      }
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      resetCaptcha();
    }
    setBusy(false);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (isForgot) {
      await onForgot();
      return;
    }
    setError(null);
    setNotice(null);
    // Signup: block a mismatched confirmation before we hit the network. The
    // field-level message (below the input) carries the explanation, so this
    // only flips it on and moves focus there.
    if (isSignup && password !== confirmPassword) {
      setConfirmTouched(true);
      confirmRef.current?.focus();
      return;
    }
    // Signup is Turnstile-gated when a site key is configured; sign-in never is
    // (captchaRequired is false outside signup/forgot by construction).
    if (captchaBlocked()) return;
    setBusy(true);
    const oauthQuery = pendingOAuthQuery();
    // Resume the OAuth flow with a TOP-LEVEL navigation once a session exists.
    // Keeps `busy` true — the page is navigating away.
    const resumeAuthorize = () => {
      window.location.assign(`/api/auth/mcp/authorize?${oauthQuery}`);
    };
    // try/catch (not try/finally): the catch is total and never re-throws, so
    // `setBusy(false)` always runs after the block -- equivalent to a finally,
    // but React Compiler can't yet lower a TryStatement with a finalizer, so a
    // finally here opts the whole component out of compilation.
    try {
      // `inviteCode` rides along in the body for the server-side invite gate
      // (worker/auth.ts hooks.before). A variable, not an inline literal, so
      // the extra field clears the client types' excess-property check.
      const signupBody = {
        name: name.trim() || email.split("@")[0] || email,
        email,
        password,
        inviteCode: inviteCode.trim(),
      };
      // disableSignal: every success branch below leaves via a top-level
      // navigation, but Better Auth otherwise fires its session signal ~10ms
      // after resolve — the /get-session refetch can flip the AuthGate and
      // mount the whole editor (collections, /api/sync socket) against the
      // previous occupant's still-live singletons before the navigation
      // commits. Errors never fire the signal, so that path is unaffected.
      //
      // On signup a Turnstile token (when configured) rides in the
      // x-captcha-response header the captcha plugin reads. Sign-in is never
      // captcha-gated and its token is always null (cleared on mode switch),
      // so it carries no header.
      const headers = captchaHeaders();
      const fetchOptions = headers
        ? { disableSignal: true, headers }
        : { disableSignal: true };
      const res = isSignup
        ? await signUp.email({ ...signupBody, fetchOptions })
        : await signIn.email({ email, password, fetchOptions });
      // A real credential/validation failure (>= 400) shows the error; on an
      // OAuth hop anything else (success, or the mcp plugin's after-hook 302
      // that fetch couldn't follow cross-origin) means the session was set —
      // resume the authorize flow.
      if (res.error && (res.error.status ?? 500) >= 400) {
        if (!isSignup && res.error.code === "EMAIL_NOT_VERIFIED") {
          // Unverified sign-in with the CORRECT password: the server just
          // auto-resent the confirmation link (emailVerification.sendOnSignIn,
          // worker/auth.ts) — say so instead of surfacing the raw error.
          setNotice(
            "Your email isn't confirmed yet. We just sent you a fresh confirmation link — check your inbox, then sign in.",
          );
        } else {
          setError(res.error.message ?? "Something went wrong. Try again.");
        }
        // A spent/failed Turnstile token can't be reused — re-challenge.
        if (isSignup) resetCaptcha();
      } else if (isSignup && res.data?.token === null) {
        // Signup succeeded but created NO session (token null =
        // requireEmailVerification is on): the account exists, the
        // verification email is out, and hard-navigating would just dump the
        // user on a bare sign-in form with no explanation. Stay put — which
        // also keeps any MCP OAuth query in the URL intact, so after
        // confirming, the normal sign-in path resumes the authorize flow —
        // flip to sign-in mode with the email prefilled, and say what to do
        // next. Guarded on token === null specifically so that if
        // verification is ever turned off (token present), the success
        // branches below keep working unchanged.
        setMode("signin");
        setNotice(
          "Account created. Check your inbox to confirm your email, then sign in.",
        );
        setCaptchaToken(null);
        setConfirmPassword("");
        setConfirmTouched(false);
      } else if (oauthQuery) {
        resumeAuthorize();
        return;
      } else {
        // Hard-navigate on success (hardReset's doc has the full why). This
        // covers what the sign-out reload can't: a session that EXPIRES flips
        // the gate here with no reload, and signing in as a different user
        // would leak the prior account's data. Sign-IN keeps the current URL
        // (a shared /$nodeId deep link, or your own spot after expiry — a
        // foreign id degrades to the missing-node view); sign-UP resets to "/"
        // (a brand-new outline has no nodes, the welcome seed beats a
        // guaranteed-missing node). Keeps `busy` true — the page is navigating
        // away.
        hardReset(isSignup ? "/" : window.location.href);
        return;
      }
    } catch {
      if (oauthQuery) {
        // The after-hook redirect can throw inside fetch (mixed content /
        // CORS) even though sign-in itself succeeded and set the session
        // cookie. Resuming authorize is correct either way: with a session it
        // completes; without one it just lands back on this login screen.
        resumeAuthorize();
        return;
      }
      setError(NETWORK_ERROR_MESSAGE);
    }
    setBusy(false);
  }

  async function joinWaitlist() {
    setError(null);
    const addr = email.trim();
    if (!addr) {
      setError("Enter your email above first, then join the waitlist.");
      return;
    }
    setWaitlist("busy");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, source: "app" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setWaitlist("done");
    } catch {
      setWaitlist("idle");
      setError("Couldn't join the waitlist. Try again.");
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">Dotflowy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isForgot
              ? "Reset your password"
              : isSignup
                ? "Create your outline"
                : "Welcome back"}
          </p>
        </div>

        {isForgot && resetSent ? (
          <p className="text-center text-sm text-muted-foreground">
            If an account exists for that email, a reset link is on its way.
            Check your inbox.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            {isSignup && (
              <Input
                type="text"
                placeholder="Name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <Input
              type="email"
              placeholder="Email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {!isForgot && (
              <Input
                type="password"
                placeholder="Password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            {isSignup && (
              <>
                <Input
                  ref={confirmRef}
                  type="password"
                  placeholder="Confirm password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  aria-invalid={showConfirmError || undefined}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setConfirmTouched(true)}
                />
                {showConfirmError && (
                  <p className="text-sm text-destructive">
                    Passwords don't match.
                  </p>
                )}
              </>
            )}
            {/* Invite code only while signup is gated. When SIGNUP_OPEN is on,
                the server skips the invite requirement, so the field would be
                dead chrome (any code entered is still redeemed harmlessly). */}
            {isSignup && !signupOpen && (
              <Input
                type="text"
                placeholder="Invite code"
                autoComplete="off"
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            )}

            {captchaRequired && turnstileSiteKey && (
              <Turnstile
                ref={turnstileRef}
                siteKey={turnstileSiteKey}
                onToken={setCaptchaToken}
              />
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && (
              <p className="text-sm text-muted-foreground">{notice}</p>
            )}

            <Button type="submit" className="w-full" disabled={busy}>
              {busy
                ? "…"
                : isForgot
                  ? "Send reset link"
                  : isSignup
                    ? "Sign up"
                    : "Sign in"}
            </Button>

            {isSignup && (
              <p className="text-center text-xs text-muted-foreground">
                By signing up you agree to our{" "}
                <a
                  href="/terms"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Terms
                </a>{" "}
                and{" "}
                <a
                  href="/privacy"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Privacy Policy
                </a>
                .
              </p>
            )}
          </form>
        )}

        {mode === "signin" && (
          <p className="mt-2 text-center text-sm">
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setMode("forgot");
                setError(null);
                setNotice(null);
                setResetSent(false);
                setCaptchaToken(null);
              }}
            >
              Forgot password?
            </button>
          </p>
        )}

        {/* Sign-in mode only: Google can't create an account (the server-side
            invite gate covers OAuth too — worker/auth.ts), so offering it on
            the signup form would only manufacture signup_disabled errors. */}
        {mode === "signin" && (
          <>
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={onGoogle}
            >
              Continue with Google
            </Button>
          </>
        )}

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isForgot ? (
            <button
              type="button"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setMode("signin");
                setError(null);
                setNotice(null);
                setResetSent(false);
                setCaptchaToken(null);
              }}
            >
              Back to sign in
            </button>
          ) : (
            <>
              {isSignup ? "Already have an account?" : "New here?"}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => {
                  setMode(isSignup ? "signin" : "signup");
                  setError(null);
                  setNotice(null);
                  setCaptchaToken(null);
                  setConfirmPassword("");
                  setConfirmTouched(false);
                }}
              >
                {isSignup
                  ? "Sign in"
                  : signupOpen
                    ? "Sign up"
                    : "Have an invite?"}
              </button>
            </>
          )}
        </p>

        {/* The waitlist is the path for people WITHOUT an invite — irrelevant
            once signup is open to everyone. */}
        {isSignup && !signupOpen && (
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {waitlist === "done" ? (
              "You're on the list! An invite will land in your inbox when Dotflowy is ready."
            ) : (
              <>
                No invite code?{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={joinWaitlist}
                  disabled={waitlist === "busy"}
                >
                  {waitlist === "busy" ? "…" : "Join the waitlist"}
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </main>
  );
}
