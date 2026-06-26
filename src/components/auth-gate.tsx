import type { ReactNode } from "react";
import { useSession } from "../lib/auth-client";
import { AuthScreen } from "./auth-screen";

/**
 * Gate the whole app behind a Better Auth session. The shell is public so this
 * renders the login screen for signed-out visitors; only the editor (and the
 * data API it hits) require a session. While the session is still loading we
 * render nothing to avoid flashing the login screen at an authed user.
 */
export function AuthGate({ children }: Readonly<{ children: ReactNode }>) {
  const { data: session, isPending } = useSession();
  if (isPending) return null;
  if (!session) return <AuthScreen />;
  return <>{children}</>;
}
