/**
 * Starts Lunora outline sync when `dotflowy:flag:lunora-sync` is ON (ADR 0055).
 * Mounted inside AuthGate so a session userId is available. Flag OFF = pass-
 * through (custom `/api/sync` path unchanged).
 *
 * Flag is read in an effect (not during SSR/prerender) so the SPA shell and
 * client hydration agree on the first paint.
 */

import { LunoraProvider } from "@lunora/react";
import { useEffect, useState, type ReactNode } from "react";

import { isLunoraSyncEnabled } from "../data/flags";
import { getLunoraClient } from "../data/lunora-client";
import {
  startLunoraOutlineSync,
  stopLunoraOutlineSync,
} from "../data/lunora-sync";
import { useSession } from "../lib/auth-client";

function LunoraOutlineBootstrap({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    startLunoraOutlineSync(userId);
    return () => {
      stopLunoraOutlineSync();
    };
  }, [userId]);

  return <>{children}</>;
}

/**
 * When the Lunora sync flag is ON, wrap children in LunoraProvider and start
 * the outline store. When OFF, pass children through unchanged (no Lunora
 * client constructed — keeps prerender / default path clean).
 */
export function LunoraSyncHost({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(isLunoraSyncEnabled());
  }, []);

  if (!enabled) return <>{children}</>;

  return (
    <LunoraProvider client={getLunoraClient()}>
      <LunoraOutlineBootstrap>{children}</LunoraOutlineBootstrap>
    </LunoraProvider>
  );
}
