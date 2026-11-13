import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useMembership } from "../data/membership";
import { useSession } from "../lib/auth-client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function MembershipWelcome() {
  const { welcome, state, reload } = useMembership();
  const { data: session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const checkout = new URLSearchParams(location.searchStr).get("checkout");
  const [timedOut, setTimedOut] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (checkout !== "success" || welcome) return;
    reload();
    let checks = 0;
    const interval = setInterval(() => {
      if (++checks >= 15) {
        clearInterval(interval);
        setTimedOut(true);
      }
      reload();
    }, 2000);
    return () => clearInterval(interval);
  }, [checkout, welcome, reload]);

  async function close(chooseTheme = false) {
    if (!welcome || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/membership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: welcome.id }),
      });
      if (!response.ok) throw new Error("Could not acknowledge membership");
      setDismissed(welcome.id);
      reload();
      void navigate(
        chooseTheme ? { to: "/settings", hash: "appearance" } : { to: "/" },
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const show = welcome !== null && welcome.id !== dismissed;
  return (
    <>
      {checkout && !show && (
        <div
          role="status"
          className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
        >
          <p>
            {checkout === "canceled"
              ? "Checkout canceled. Your plan hasn't changed."
              : state === "error"
                ? "We couldn't confirm your membership yet. You can keep writing."
                : timedOut
                  ? "Confirmation is taking longer than usual. You can keep writing, and check your plan again."
                  : "Confirming your membership. You can keep writing while we wait."}
          </p>
          {checkout === "success" && (
            <Button variant="outline" size="sm" onClick={reload}>
              Check again
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={show}
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          initialFocus={backButton}
        >
          <DialogHeader>
            <p className="text-sm font-medium text-muted-foreground">
              A note from Cam
            </p>
            <DialogTitle>
              Thank you
              {session?.user.name?.trim()
                ? `, ${session.user.name.trim().split(/\s+/)[0]}`
                : ""}
              .
            </DialogTitle>
            <DialogDescription>
              {welcome?.plan === "founding"
                ? "Thank you for becoming a founding member of Dotflowy."
                : "Thank you for supporting Dotflowy."}
            </DialogDescription>
          </DialogHeader>
          <p>
            Your subscription helps me keep building Dotflowy. I'm grateful
            you've chosen to support it.
          </p>
          <p>
            You can now choose any theme, connect your AI apps, and write
            without a node limit. If something gets in your way, choose Send
            feedback in the app menu. It comes to me.
          </p>
          {welcome?.plan === "founding" && (
            <p className="text-sm text-muted-foreground">
              Your founding term runs three years, then renews unless you
              cancel. You can manage it anytime in Settings.
            </p>
          )}
          <p>Cam</p>
          {error && (
            <p role="alert" className="text-destructive">
              Couldn't save your dismissal. Try again.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void close(true)}
            >
              Choose a theme
            </Button>
            <Button
              ref={backButton}
              disabled={busy}
              onClick={() => void close()}
            >
              Back to my outline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
