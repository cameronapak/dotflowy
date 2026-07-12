/// <reference types="@cloudflare/workers-types" />
import type { CloudflareOptions } from "@sentry/cloudflare";

/**
 * Error monitoring for the Worker + Durable Object (ticket #227, decided in
 * #156): Sentry, errors-only, layered on the Workers Logs already enabled.
 * Deliberately NO tracing/APM/replay — omitting `tracesSampleRate` keeps this
 * to exception capture only.
 *
 * The DSN is public-by-design (it also ships in the client bundle), so it lives
 * as a `wrangler.jsonc` var, not a secret. When unset — local `wrangler dev`,
 * unit tests, a trimmed config — Sentry stays dormant and nothing phones home.
 */

/** The slice of the Worker env this seam needs. */
export interface SentryEnv {
  /** Public Sentry DSN (wrangler.jsonc var). Unset => Sentry is a no-op. */
  SENTRY_DSN?: string;
}

/** The user-authored fields we strip from every outbound event. */
interface ScrubbableRequest {
  data?: unknown;
  cookies?: unknown;
  query_string?: unknown;
  headers?: Record<string, string>;
}

/**
 * Strip anything user-authored from an outbound event before it leaves the
 * isolate. Outline node text must NEVER ride an error payload (#227): we drop
 * the request body, the query string (the `?q=` filter and `?url=` unfurl carry
 * user text), cookies, and the auth header.
 */
export function scrubRequest(request: ScrubbableRequest | undefined): void {
  if (!request) return;
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

/**
 * Errors-only Sentry options for the Worker handler and the Durable Object.
 * Both `withSentry` and `instrumentDurableObjectWithSentry` take an
 * `(env) => options` callback, so the DSN is read from env at request time.
 */
export function workerSentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    beforeSend(event) {
      scrubRequest(event.request);
      return event;
    },
  };
}
