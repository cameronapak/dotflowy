/// <reference types="@cloudflare/workers-types" />
import type { CloudflareOptions } from "@sentry/cloudflare";

import { scrubSentryEvent } from "../src/data/sentry-scrub";

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

/**
 * Errors-only Sentry options for the Worker handler and the Durable Object.
 * Both `withSentry` and `instrumentDurableObjectWithSentry` take an
 * `(env) => options` callback, so the DSN is read from env at request time.
 * `beforeSend` runs the shared scrub — the Worker and the client share ONE leaf
 * (src/data/sentry-scrub.ts) so the "node text never rides an error report"
 * guarantee can't drift between them.
 */
export function workerSentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
  };
}
