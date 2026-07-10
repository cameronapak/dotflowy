import { ManagedRuntime } from "effect";
import { Socket } from "effect/unstable/socket";

/**
 * The app's single long-lived Effect runtime.
 *
 * Most Effect in this codebase runs request-scoped through `runPromise`
 * (kv-client-effect.ts). The sync socket is different: it's one fiber that lives
 * for the whole session (connect, reconnect, apply frames). That fiber needs a
 * runtime whose service layer is built ONCE and shared, so this module owns it.
 *
 * Today the only service is `WebSocketConstructor` (Effect's injectable
 * `new WebSocket(...)` factory) — `layerWebSocketConstructorGlobal` provides the
 * real browser constructor; a unit test provides a fake one to drive
 * reconnect/backoff deterministically with `TestClock`. As more of the app
 * converts to Effect, new services join this one layer.
 *
 * SSR-safe: `ManagedRuntime.make` is lazy (it builds no layer until first run),
 * and the layer only hands over a constructor function — it never touches
 * `globalThis.WebSocket`. collection.ts still guards the `/` prerender with a
 * `typeof window` check before it forks anything onto this runtime.
 */
export const appRuntime = ManagedRuntime.make(
  Socket.layerWebSocketConstructorGlobal,
);
