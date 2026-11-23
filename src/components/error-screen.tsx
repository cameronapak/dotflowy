import type { ErrorComponentProps } from "@tanstack/react-router";

import * as Sentry from "@sentry/react";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useId, useRef } from "react";

import { Button } from "./ui/button";
import { buttonVariants } from "./ui/button-variants";

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

  // Browser import rejections (Chromium, Firefox, Safari), not generic fetch
  // failures or exceptions thrown by a successfully loaded module.
  if (
    error instanceof TypeError &&
    (/^(Failed to fetch dynamically imported module:|error loading dynamically imported module:|Importing a module script failed\.?$)/.test(
      error.message,
    ) ||
      /^'[^']+' is not a valid JavaScript MIME type for module script '/.test(
        error.message,
      ))
  ) {
    return <RouteLoadRecovery />;
  }

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

function RouteLoadRecovery() {
  const isOutline = useLocation({
    select: (location) => location.pathname === "/",
  });
  const title = useRef<HTMLHeadingElement>(null);
  const warningId = useId();

  useEffect(() => {
    title.current?.focus();
  }, []);

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="max-w-sm space-y-1">
        <h1 ref={title} tabIndex={-1} className="text-lg font-medium">
          This page couldn’t load
        </h1>
        <p id={warningId} className="text-sm text-muted-foreground">
          Check your connection. Reload to try again once your changes are
          saved.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {!isOutline && (
          <Link to="/" replace className={buttonVariants()}>
            Open outline
          </Link>
        )}
        <Button
          variant="outline"
          aria-describedby={warningId}
          onClick={() => window.location.reload()}
        >
          Reload page
        </Button>
      </div>
    </main>
  );
}
