import { useState, type FormEvent } from "react";
import { signIn, signUp } from "../lib/auth-client";
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
  const params = new URLSearchParams(window.location.search)
  const isAuthorize =
    params.has("client_id") && params.has("redirect_uri") && params.has("response_type")
  return isAuthorize ? params.toString() : null
}

export function AuthScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignup = mode === "signup";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
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
      const res = isSignup
        ? await signUp.email({
            name: name.trim() || email.split("@")[0] || email,
            email,
            password,
          })
        : await signIn.email({ email, password });
      // A real credential/validation failure (>= 400) shows the error; on an
      // OAuth hop anything else (success, or the mcp plugin's after-hook 302
      // that fetch couldn't follow cross-origin) means the session was set —
      // resume the authorize flow.
      if (res.error && (res.error.status ?? 500) >= 400) {
        setError(res.error.message ?? "Something went wrong. Try again.");
      } else if (oauthQuery) {
        resumeAuthorize();
        return;
      }
      // On success the session store updates and the gate swaps in the editor.
    } catch {
      if (oauthQuery) {
        // The after-hook redirect can throw inside fetch (mixed content /
        // CORS) even though sign-in itself succeeded and set the session
        // cookie. Resuming authorize is correct either way: with a session it
        // completes; without one it just lands back on this login screen.
        resumeAuthorize();
        return;
      }
      setError("Network error. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold">Dotflowy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isSignup ? "Create your outline" : "Welcome back"}
          </p>
        </div>

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
          <Input
            type="password"
            placeholder="Password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "…" : isSignup ? "Sign up" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isSignup ? "Already have an account?" : "New here?"}{" "}
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(isSignup ? "signin" : "signup");
              setError(null);
            }}
          >
            {isSignup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </main>
  );
}
