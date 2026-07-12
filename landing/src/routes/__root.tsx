import type { ReactNode } from "react";

import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import "../styles.css";

const TITLE = "Dotflowy — an open-source outliner. Workflowy, but yours.";
const DESCRIPTION =
  "A fast, keyboard-first outliner you can own and extend. Open-source, real-time sync, daily notes, tags, and an outline your AI can edit too. A Workflowy alternative.";
const URL = "https://dotflowy.com";

// Respect the visitor's system theme with no flash of the wrong one. The app's
// `dark` variant keys off a `.dark` class on <html>; add it before first paint
// when the OS prefers dark. No toggle on the marketing page by design.
const noFlashThemeScript = `
(function () {
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: URL },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:image", content: `${URL}/og.png` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${URL}/og.png` },
    ],
    links: [{ rel: "canonical", href: URL }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className="[scrollbar-gutter:stable]"
      suppressHydrationWarning
    >
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
