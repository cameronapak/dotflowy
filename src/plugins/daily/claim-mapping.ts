/**
 * Pure daily-index claim (ADR 0052 / DO `getOrCreateKv` twin).
 * Pre-existing mapping wins; candidate wins only when the key is absent.
 */

export type DailyClaimResult = {
  winner: string;
  won: boolean;
};

/**
 * Resolve an atomic claim: if `existingNodeId` is set, that id wins and this
 * caller lost; otherwise `candidate` wins.
 */
export function resolveDailyClaim(
  existingNodeId: string | null | undefined,
  candidate: string,
): DailyClaimResult {
  if (existingNodeId != null && existingNodeId !== "") {
    // DO twin: winner is whatever is stored; `won` iff our candidate matches
    // (re-claim of the same id is a no-op insert but still "our" mapping).
    return {
      winner: existingNodeId,
      won: existingNodeId === candidate,
    };
  }
  return { winner: candidate, won: true };
}
