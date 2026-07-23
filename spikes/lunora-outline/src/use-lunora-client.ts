import type { LunoraClient } from "lunorash/client";

import { useLunora } from "@lunora/react";

/** The LunoraClient from LunoraProvider (typed for outline-store wiring). */
export function useLunoraClient(): LunoraClient {
  return useLunora() as LunoraClient;
}
