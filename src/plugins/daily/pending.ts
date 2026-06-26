import { useSyncExternalStore } from 'react'

let pendingDepth = 0
const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): boolean {
  return pendingDepth > 0
}

function beginDailyNavigation(): void {
  pendingDepth += 1
  notify()
}

function endDailyNavigation(): void {
  pendingDepth = Math.max(0, pendingDepth - 1)
  notify()
}

export function useDailyNavigationPending(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** Wrap async daily get-or-create work with shared pending state. */
export async function withDailyNavigation<T>(
  fn: () => Promise<T>,
): Promise<T> {
  beginDailyNavigation()
  try {
    return await fn()
  } finally {
    endDailyNavigation()
  }
}
