import type { ReactNode } from "react";
import { HeadContent, Scripts } from "@tanstack/react-router";
import { LEGACY_THEME_KEY, THEME_KEY } from "../lib/storage-keys";

// Runs before first paint so the page never flashes the wrong theme. Mirrors
// the resolution logic in theme-provider.tsx (same storage key).
const noFlashThemeScript = `
(function () {
  try {
    var key = '${THEME_KEY}';
    var legacy = '${LEGACY_THEME_KEY}';
    var t = localStorage.getItem(key);
    if (!t) {
      t = localStorage.getItem(legacy);
      if (t) {
        localStorage.setItem(key, t);
        localStorage.removeItem(legacy);
      }
    }
    t = t || 'system';
    var dark = t === 'dark' || (t === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="[scrollbar-gutter:stable]">
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashThemeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
