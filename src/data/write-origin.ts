/**
 * Transport-only identity for this page load. It correlates REST writes with
 * their WebSocket echoes; it is neither account identity nor node provenance.
 * Kept DOM-free so the transport core remains usable in Bun tests.
 */
const clientId = globalThis.crypto.randomUUID();

export function getWriteClientId(): string {
  return clientId;
}
