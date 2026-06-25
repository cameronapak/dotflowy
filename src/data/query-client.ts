import { QueryClient } from '@tanstack/query-core'

/**
 * One app-wide QueryClient backing the nodes collection (collection.ts).
 *
 * `refetchOnWindowFocus` is the v1 cross-device sync cadence: switch back to a
 * tab and it re-pulls the full node set via `getNodes`, picking up edits made
 * on another device. Real-time push is deferred (PRD v2.x).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 0,
      retry: 1,
    },
  },
})
