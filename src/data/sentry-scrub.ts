/**
 * The ONE place we strip user-authored text from an outbound Sentry event
 * (#227). Shared by the client (`src/instrument.client.ts`, @sentry/react) and
 * the Worker/DO (`worker/sentry.ts`, @sentry/cloudflare) so the two can't drift
 * on the privacy guarantee the policy makes: "your note text never rides an
 * error report".
 *
 * Pure and DOM-free (no `window`, no workers-types), structurally typed so both
 * SDKs' `ErrorEvent` satisfy it — that's why it lives in `src/data` (the worker
 * already imports from here, e.g. `redactSpoilers`) rather than in `worker/`.
 *
 * The leak this closes is NOT the obvious fields: both SDKs populate
 * `event.request.url` with the FULL url (query string included), and the
 * browser SDK adds navigation breadcrumbs with `?q=…` in them. Deleting only
 * `query_string` (an earlier version's mistake) leaves the `?q=` outline filter
 * and the `?url=` unfurl target — both user-authored — in `request.url`, the
 * `Referer` header, and breadcrumb URLs. So we drop the query string wherever a
 * url appears, keeping the path for debugging.
 */

interface ScrubbableEvent {
  request?: {
    url?: string;
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    headers?: Record<string, string>;
  };
  breadcrumbs?: Array<{ data?: BreadcrumbData } | undefined>;
}

/** Breadcrumb `data` as the browser SDK's navigation/fetch integrations shape
 *  it: url-bearing string fields we strip query strings from. */
interface BreadcrumbData {
  from?: string | null;
  to?: string | null;
  url?: string | null;
}

/** Drop everything after the first `?` (keep origin + path). */
function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Type-guard predicate: Sentry url-bearing fields are optional strings. */
const isString = (v: string | null | undefined): v is string =>
  typeof v === "string";

export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    if (isString(request.url)) {
      request.url = stripQuery(request.url);
    }
    if (request.headers) {
      for (const header of [
        "authorization",
        "Authorization",
        "cookie",
        "Cookie",
        "referer",
        "Referer",
      ]) {
        delete request.headers[header];
      }
    }
  }

  // Navigation/fetch breadcrumbs carry url-shaped fields (the browser SDK's
  // history + fetch integrations), so a ?q= filter change rides `to`/`from`.
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      const data = crumb?.data;
      if (!data) continue;
      for (const key of ["from", "to", "url"] as const) {
        const value = data[key];
        if (isString(value)) data[key] = stripQuery(value);
      }
    }
  }

  return event;
}
