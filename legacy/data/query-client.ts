import { QueryClient } from '@tanstack/query-core'

/**
 * One app-wide QueryClient backing the nodes collection (collection.ts).
 *
 * `refetchOnWindowFocus` is the v1 cross-device sync cadence: switch back to a
 * tab and it re-pulls the full node set from D1, picking up edits made on
 * another device. Real-time push (Durable Objects) is the deferred next step.
 * See docs/DECISIONS.md (D1 sync).
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
