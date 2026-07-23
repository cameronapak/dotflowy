import { createAuthClient } from "better-auth/react";

const baseURL =
  (import.meta.env.VITE_LUNORA_URL as string | undefined) ??
  globalThis.location.origin;

export const authClient = createAuthClient({ baseURL });
