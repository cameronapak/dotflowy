import { QueryClient } from '@tanstack/query-core'

/**
 * One app-wide QueryClient backing the plugin side-collections (tag-colors,
 * daily-index) -- the kv query collections in src/plugins/.
 *
 * The nodes collection no longer uses this: it moved to a real-time custom-sync
 * adapter over a per-user Durable Object socket (collection.ts + realtime.ts).
 * The kv side-collections stay query collections, so `refetchOnWindowFocus` is
 * still their cross-device cadence: switch back to a tab and they re-pull,
 * picking up tag colors / daily mappings created on another device. See
 * docs/adr/0008-sync-via-a-per-user-durable-object.md.
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
