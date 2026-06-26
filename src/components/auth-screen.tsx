import { useState, type FormEvent } from "react";
import { signIn, signUp } from "../lib/auth-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The unauthenticated view. Email + password, with a sign in / sign up toggle.
 * Rendered by the root AuthGate when there's no session; a successful auth
 * action updates the session store, which flips the gate to the editor. The
 * app shell is public (worker/index.ts), so this loads without a session.
 */
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
    try {
      const res = isSignup
        ? await signUp.email({
            name: name.trim() || email.split("@")[0] || email,
            email,
            password,
          })
        : await signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message ?? "Something went wrong. Try again.");
      }
      // On success the session store updates and the gate swaps in the editor.
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
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
