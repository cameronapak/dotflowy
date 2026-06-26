import { useReducer, type FormEvent } from "react";
import { signIn, signUp } from "../lib/auth-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type AuthMode = "signin" | "signup";

type AuthState = {
  mode: AuthMode;
  name: string;
  email: string;
  password: string;
  error: string | null;
  busy: boolean;
};

type AuthAction =
  | { type: "set-mode"; mode: AuthMode }
  | { type: "set-name"; name: string }
  | { type: "set-email"; email: string }
  | { type: "set-password"; password: string }
  | { type: "submit-start" }
  | { type: "submit-error"; error: string }
  | { type: "submit-end" };

const initialAuthState: AuthState = {
  mode: "signin",
  name: "",
  email: "",
  password: "",
  error: null,
  busy: false,
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "set-mode":
      return { ...state, mode: action.mode, error: null };
    case "set-name":
      return { ...state, name: action.name };
    case "set-email":
      return { ...state, email: action.email };
    case "set-password":
      return { ...state, password: action.password };
    case "submit-start":
      return { ...state, error: null, busy: true };
    case "submit-error":
      return { ...state, error: action.error, busy: false };
    case "submit-end":
      return { ...state, busy: false };
  }
}

/**
 * The unauthenticated view. Email + password, with a sign in / sign up toggle.
 * Rendered by the root AuthGate when there's no session; a successful auth
 * action updates the session store, which flips the gate to the editor. The
 * app shell is public (worker/index.ts), so this loads without a session.
 */
export function AuthScreen() {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const { mode, name, email, password, error, busy } = state;
  const isSignup = mode === "signup";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    dispatch({ type: "submit-start" });
    try {
      const res = isSignup
        ? await signUp.email({
            name: name.trim() || email.split("@")[0] || email,
            email,
            password,
          })
        : await signIn.email({ email, password });
      if (res.error) {
        dispatch({
          type: "submit-error",
          error: res.error.message ?? "Something went wrong. Try again.",
        });
        return;
      }
      // On success the session store updates and the gate swaps in the editor.
      dispatch({ type: "submit-end" });
    } catch {
      dispatch({
        type: "submit-error",
        error: "Network error. Check your connection and try again.",
      });
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
              onChange={(e) =>
                dispatch({ type: "set-name", name: e.target.value })
              }
            />
          )}
          <Input
            type="email"
            placeholder="Email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) =>
              dispatch({ type: "set-email", email: e.target.value })
            }
          />
          <Input
            type="password"
            placeholder="Password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={8}
            value={password}
            onChange={(e) =>
              dispatch({ type: "set-password", password: e.target.value })
            }
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
            onClick={() =>
              dispatch({
                type: "set-mode",
                mode: isSignup ? "signin" : "signup",
              })
            }
          >
            {isSignup ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </main>
  );
}
