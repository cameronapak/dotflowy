import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { hardReset } from "../lib/auth-client";

export const Route = createFileRoute("/mcp-consent")({
  validateSearch: (search: { consent_code?: unknown }) => ({
    consent_code: Schema.is(Schema.String)(search.consent_code)
      ? search.consent_code
      : "",
  }),
  remountDeps: ({ search }) => search.consent_code,
  component: McpConsent,
});

interface ConsentDetails {
  name: string;
  redirectHost: string;
  scopes: string[];
  email: string;
}

function McpConsent() {
  const { consent_code: code } = Route.useSearch();
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void fetch(`/api/mcp-consent?code=${encodeURIComponent(code)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "This connection request expired or belongs to another account. Reconnect from your app.",
          );
        // SAFETY: Same-origin endpoint returns only provider-validated consent details.
        const body = (await response.json()) as ConsentDetails;
        if (current) setDetails(body);
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load the connection request.",
          );
      });
    return () => {
      current = false;
    };
  }, [code]);

  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept, consent_code: code }),
      });
      if (!response.ok)
        throw new Error(
          "Could not finish connecting. Reconnect from your app.",
        );
      // SAFETY: Redirect is constructed server-side from the registered OAuth callback.
      const body = (await response.json()) as { redirectURI: string };
      hardReset(body.redirectURI);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not finish connecting.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg items-center px-5 py-10">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>
            <h1>Connect to Dotflowy</h1>
          </CardTitle>
          <CardDescription>
            App names are self-reported. Check the return hostname and only
            connect an app you trust.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {details ? (
            <>
              <p className="break-words">
                <strong>{details.name}</strong> wants access to{" "}
                <strong>{details.email}</strong>.
              </p>
              <p className="break-all">
                Return to: <strong>{details.redirectHost}</strong>
              </p>
              <ul className="flex list-disc flex-col gap-2 pl-5">
                <li>Read, search, and export your entire outline.</li>
                <li>
                  Add, edit, move, and delete nodes, including shared mirror
                  content.
                </li>
                {details.scopes.includes("offline_access") && (
                  <li>Keep access through refresh tokens when you are away.</li>
                )}
              </ul>
              <p className="text-muted-foreground">
                OAuth connections have read and write access, not per-folder
                permissions. For read-only access, use an API key if your app
                supports it. Outline access requires Pro or Founding. Connecting
                does not start a trial or authorize payment.
              </p>
              <p className="text-muted-foreground">
                Revoke access in Settings → Connections → Authorized apps.
                Removing an app in Claude alone may not revoke its tokens.
              </p>
              <p>
                <a
                  className="underline"
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Privacy policy
                </a>
              </p>
            </>
          ) : (
            !error && <p role="status">Loading connection request…</p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {details ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Deny
              </Button>
              <Button disabled={busy} onClick={() => void decide(true)}>
                {busy ? "Finishing…" : "Allow access"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => hardReset("/")}>
              Back to Dotflowy
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  );
}
