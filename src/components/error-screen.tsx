import type { ErrorComponentProps } from "@tanstack/react-router";

import * as Sentry from "@sentry/react";
import { useEffect } from "react";

import { Button } from "./ui/button";

/**
 * The router's `defaultErrorComponent` (ticket #227): a render error shows a
 * humane screen instead of a white page, and reports to Sentry. `reset` retries
 * the failed render; a full reload is the harder escape hatch.
 *
 * `Sentry.captureException` is a no-op until `Sentry.init` has run (PROD only,
 * see instrument.client.ts), so this is safe to call unconditionally.
 */
export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-medium">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The error was reported. Try again, or reload the app.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => reset()}>
          Try again
        </Button>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}
