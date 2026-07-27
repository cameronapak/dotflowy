/**
 * Cooperative cancel gate for inline `@agent` (ADR 0059).
 * Only a still-running row may land an answer — Stop patches status first;
 * commit must refuse afterwards.
 */
export function agentRunAllowsAnswerCommit(status: unknown): boolean {
  return status === "running";
}
