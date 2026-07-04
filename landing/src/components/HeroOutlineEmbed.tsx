import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

// The app origin. Overridable for local dev (point VITE_APP_URL at
// http://localhost:3000 to embed a locally-running app); defaults to prod.
const APP_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_APP_URL ??
  "https://app.dotflowy.com";
// `?demo=1` boots the app's anonymous, in-memory demo mode (no auth, no Worker
// — src/data/demo-backend.ts). The app Worker's CSP `frame-ancestors` allows
// dotflowy.com to frame it.
const DEMO_URL = `${APP_URL}/?demo=1`;

/**
 * The hero's signature: the REAL Dotflowy editor, embedded live in a Floating
 * Panel with faux window chrome (DESIGN.md §5). It replaces the old local-state
 * toy — this is literally the product, running an in-memory backend, so it can't
 * drift from the app.
 *
 * Kept fast per the brand promise: the iframe is client-only and lazy. The
 * prerendered HTML ships only the skeleton; a client IntersectionObserver mounts
 * the iframe when the panel nears the viewport, and it fades in on load. First
 * paint never pays for the app bundle.
 */
export function HeroOutlineEmbed() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      // Start loading a little before it scrolls in, so it's ready on arrival.
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <figure>
      <div
        ref={panelRef}
        className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 shadow-[0_12px_40px_-12px_oklch(0.2_0_0/0.18)]"
      >
        {/* Faux window chrome */}
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <div className="flex items-center gap-2 font-mono text-[13px] font-medium">
            <span className="size-2.5 rounded-full bg-foreground/70" />
            dotflowy
          </div>
          <span className="hidden items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
            <span className="text-[13px]">⌘</span>K
          </span>
        </div>

        {/* Editor body: a static skeleton holds the space until the live iframe
            loads over it (no layout shift, no white flash). */}
        <div className="relative h-[460px] sm:h-[520px]">
          <div
            aria-hidden
            className={cn(
              "absolute inset-0 space-y-3 px-5 py-6 transition-opacity duration-500",
              loaded && "opacity-0",
            )}
          >
            <div className="flex items-center gap-2.5">
              <span className="size-1.5 shrink-0 rounded-full bg-foreground/25" />
              <span className="h-3 w-40 rounded bg-foreground/10" />
            </div>
            {[28, 20, 24].map((w, i) => (
              <div key={i} className="flex items-center gap-2.5 pl-6">
                <span className="size-1.5 shrink-0 rounded-full bg-foreground/20" />
                <span
                  className="h-3 rounded bg-foreground/[0.07]"
                  style={{ width: `${w * 4}px` }}
                />
              </div>
            ))}
          </div>

          {inView && (
            <iframe
              src={DEMO_URL}
              title="A live Dotflowy outline you can edit"
              loading="lazy"
              onLoad={() => setLoaded(true)}
              // Its own origin (app.dotflowy.com) for storage/theme; scripts to
              // run; popups/links to open; but it can't navigate this page.
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              className={cn(
                "absolute inset-0 h-full w-full border-0 bg-background transition-opacity duration-500",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
          )}
        </div>
      </div>

      <figcaption className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center font-mono text-xs text-muted-foreground">
        <span>The real editor —</span>
        <Kbd>Enter</Kbd>
        <span>new line,</span>
        <Kbd>Tab</Kbd>
        <span>to nest, click a • to zoom.</span>
      </figcaption>
    </figure>
  );
}
