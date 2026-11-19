import type { Socket } from "effect/socket";

export type SyncDiagnostic =
  | { event: "connect"; mode: "snapshot" | "resume" }
  | { event: "applied"; mode: "snapshot" | "resume" }
  | { event: "resync"; reason: "sequence-gap" | "echo-timeout" }
  | {
      event: "retry";
      reason: "hello-timeout" | "unexpected" | Socket.SocketErrorReason["_tag"];
      closeCode?: number;
      attempt: number;
      delayMs: number;
      hadHandshake: boolean;
    };

export function logSyncDiagnostic(diagnostic: SyncDiagnostic): void {
  if (!import.meta.env.DEV && import.meta.env.DOTFLOWY_CF_DEV !== true) return;
  console.debug(`[dotflowy:sync] ${JSON.stringify(diagnostic)}`);
}
