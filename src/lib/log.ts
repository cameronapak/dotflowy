/// <reference types="vite/client" />
import { initLog, log, setIdentity, clearIdentity } from 'evlog/client'

/**
 * SPA client logging (evlog/client).
 *
 * Console-only for now: structured events land in the browser devtools console
 * (pretty-printed in dev, JSON in prod). evlog's `initLog` touches no browser
 * globals, so importing this module is safe during the build-time prerender
 * of `/`; the only window access (error capture) is guarded below.
 *
 * Upgrade path — to ship these to the Worker (so they show up in `wrangler tail`
 * next to the server's wide events, where an agent can read them after the
 * fact), pass a `transport` here pointing at an `/api/logs` ingest route and add
 * that route to the Worker. See `evlog/http` (`createHttpLogDrain`).
 */
let started = false

export function initClientLog() {
  if (started) return
  started = true
  initLog({
    console: true,
    pretty: import.meta.env.DEV,
    service: 'dotflowy-client',
    minLevel: import.meta.env.DEV ? 'debug' : 'info',
  })
  installErrorCapture()
}

/**
 * Surface otherwise-invisible client crashes — uncaught errors and unhandled
 * promise rejections — as structured `error` logs. These are exactly the
 * failures that vanish from a user's console before anyone can read them.
 * Browser-only; a no-op during prerender.
 */
function installErrorCapture() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (e) => {
    log.error({
      event: 'window.error',
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    log.error({ event: 'unhandledrejection', reason: String(e.reason) })
  })
}

export { log, setIdentity, clearIdentity }
