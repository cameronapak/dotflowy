/// <reference types="vite/client" />

/**
 * Client-visible environment variables (the `VITE_`-prefixed ones Vite inlines
 * into the browser bundle). The non-prefixed secrets in `.env`
 * (`JAZZ_ADMIN_SECRET`, `BACKEND_SECRET`) are deliberately absent here: they are
 * server-only and must never reach the client.
 */
interface ImportMetaEnv {
  /** Registered Jazz app id (Jazz Cloud). Falls back to a local id if unset. */
  readonly VITE_JAZZ_APP_ID?: string
  /** Jazz sync server URL. When set, the client syncs to it; unset = local-only. */
  readonly VITE_JAZZ_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
