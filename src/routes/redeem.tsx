import { createFileRoute } from "@tanstack/react-router";

import { AuthScreen } from "../components/auth-screen";
import { RedeemProReward } from "../components/pro-reward";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { MembershipProvider } from "../data/membership";
import { signOutAndReload, useSession } from "../lib/auth-client";

export const Route = createFileRoute("/redeem")({
  component: RedeemPage,
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
});

function RedeemPage() {
  const { data: session, isPending, error } = useSession();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 px-6 py-10 sm:py-16">
      <a href="/" className="self-start text-sm font-medium">
        Dotflowy
      </a>
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Redeem your Pro code</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A thank-you for helping make Dotflowy better. Your code adds 30 days
          of Pro. You'll review your account and estimated dates before
          claiming.
        </p>
      </header>
      {isPending ? (
        <p role="status">Checking your account…</p>
      ) : error ? (
        <p role="alert">
          Couldn't check your account. Reload this page to try again.
        </p>
      ) : !session ? (
        <>
          <p className="text-sm text-muted-foreground">
            Sign in or create an account first. After confirming your email,
            you'll return here to sign in. Keep your code handy for the next
            step.
          </p>
          <Card>
            <CardContent>
              <AuthScreen returnTo="/redeem" />
            </CardContent>
          </Card>
        </>
      ) : !session.user.emailVerified ? (
        <div className="flex flex-col gap-3">
          <p role="alert">
            Confirm your email before claiming. Sign out, then sign in to
            request a fresh confirmation link.
          </p>
          <Button variant="outline" onClick={() => signOutAndReload("/redeem")}>
            Sign out
          </Button>
        </div>
      ) : (
        <MembershipProvider key={session.user.id}>
          <RedeemProReward
            key={session.user.id}
            accountId={session.user.id}
            email={session.user.email}
          />
        </MembershipProvider>
      )}
    </main>
  );
}
