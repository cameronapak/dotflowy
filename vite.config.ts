import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { wasp } from "wasp/client/vite";

// Wasp owns the Vite config now (was TanStack Start). The `wasp()` plugin wires
// the generated client; `@tailwindcss/vite` keeps Tailwind v4 working.
export default defineConfig({
  plugins: [wasp(), tailwindcss()],
});
