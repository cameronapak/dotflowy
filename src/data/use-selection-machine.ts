import { useMachine } from '@xstate/react'
import { selectionMachine } from './selection-machine'

/**
 * Thin React binding for the PoC selection machine, present to validate that the
 * XState v6 React adapter (`@xstate/react@7.0.0-alpha.1`) typechecks against
 * React 19. `useMachine` returns `[snapshot, send, actorRef]`; it's built on
 * `useSyncExternalStore`, the same primitive `tree-store`/`selection-state` use,
 * so a future swap-in can read per-row via `useSelector(actorRef, …)` and keep
 * the ADR 0014 per-node-render budget.
 *
 * UNCONSUMED for now — wiring this into `selection-mode.tsx` behind
 * `isSelectionMachine()` is the next step (see `.scratch/xstate-effect-schema/`).
 */
export function useSelectionMachine() {
  return useMachine(selectionMachine)
}
