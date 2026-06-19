import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

// SPA mode: no SSR. This sidesteps localStorage-on-server entirely,
// which matters because TanStack DB's localStorage collection reads
// globalThis.localStorage. With SPA mode there's no server render pass
// for routes, so the collection is only ever touched in the browser.
//
// It also keeps deployment trivial: any static CDN works.
export default defineConfig({
  server: { port: 3000 },
  plugins: [
    tanstackStart({
      spa: { enabled: true },
    }),
    // Order matters: react's plugin must come after Start's.
    viteReact(),
  ],
})
