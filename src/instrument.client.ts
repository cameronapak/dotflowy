import * as Sentry from "@sentry/react";

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
    beforeSend(event) {
      // Outline node text must never ride an error payload (#227): drop the
      // request body, query string (?q= filter / ?url= unfurl carry user
      // text), cookies, and the auth header.
      const request = event.request;
      if (request) {
        delete request.data;
        delete request.cookies;
        delete request.query_string;
        if (request.headers) {
          for (const header of [
            "authorization",
            "Authorization",
            "cookie",
            "Cookie",
          ]) {
            delete request.headers[header];
          }
        }
      }
      return event;
    },
  });
}
