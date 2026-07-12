import * as Sentry from "@sentry/react";

import { scrubSentryEvent } from "./data/sentry-scrub";

/**
 * Client-side error monitoring (ticket #227, decided in #156): Sentry,
 * errors-only. Omitting tracing/replay integrations keeps this to exception
 * capture (~35 KB gzip). Imported as the FIRST import in the root route module
 * so it initializes before the app renders.
 *
 * SPA-mode note: there is no client entry file to put this in front of, so the
 * root route module (`__root.tsx`) is the earliest reliable app code. The
 * guards below keep it a no-op during the build's static prerender (no window)
 * and in dev (only PROD), so dev throws never pollute the issue feed.
 *
 * The DSN is public-by-design; it comes from `VITE_SENTRY_DSN` (a committed
 * `.env.production` value, not a secret). Unset => Sentry stays dormant.
 */
const dsn = import.meta.env.VITE_SENTRY_DSN;

if (import.meta.env.PROD && dsn && typeof window !== "undefined") {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    // Shared scrub (src/data/sentry-scrub.ts, same leaf the Worker uses):
    // outline node text must never ride an error payload (#227). The leak isn't
    // the obvious fields — the browser SDK puts the full href (incl. the ?q=
    // filter) in request.url and navigation breadcrumbs, so the scrub strips
    // the query string wherever a url appears.
    beforeSend: (event) => scrubSentryEvent(event),
  });
}
