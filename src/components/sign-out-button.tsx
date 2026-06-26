import { LogOutIcon } from "lucide-react";
import { Button } from "./ui/button";
import { signOut } from "../lib/auth-client";

/**
 * Header sign-out control. Clearing the session updates the auth store, which
 * flips the root AuthGate back to the login screen.
 */
export function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => signOut()}
      title="Sign out"
    >
      <LogOutIcon />
      <span className="sr-only">Sign out</span>
    </Button>
  );
}
