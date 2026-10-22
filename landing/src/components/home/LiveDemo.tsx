import { RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { APP_URL, LinkButton } from "@/components/SiteChrome";
import { cn } from "@/lib/utils";

/* The live demo: the real app, framed, inline in the hero (LiveDemo) and as
 * its own page for phones (routes/try.tsx). It boots at `/demo`, where
 * the app answers its own /api in the browser (src/demo/backend.ts), so a
 * visitor zooms, jumps, and types in the production editor with no account,
 * and nothing they do is saved. The iframe `name` keeps a reload inside the
 * frame in demo mode after zooming has changed its path. */

/** Must match DEMO_FRAME_NAME in the app's src/demo/backend.ts. */
const DEMO_FRAME_NAME = "dotflowy-demo";

/** Where the demo app lives. Local and preview builds point it at their own
 * app server; production is the app itself. */
const DEMO_APP_URL = import.meta.env.VITE_DEMO_APP_URL ?? APP_URL;

const HINTS: { keys: string[]; label: string }[] = [
  { keys: [], label: "Click a dot to zoom in" },
  { keys: ["⌘", ","], label: "zoom out" },
  { keys: ["⌘", "K"], label: "jump anywhere" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-card px-1.5 font-sans text-xs font-medium text-foreground shadow-[0_1px_0_var(--border)]">
      {children}
    </kbd>
  );
}

/** A fresh boot of the demo app: bump `run` to start over with a new outline. */
export function DemoFrame({
  run,
  className,
}: {
  run: number;
  className?: string;
}) {
  return (
    <iframe
      key={run}
      name={DEMO_FRAME_NAME}
      src={`${DEMO_APP_URL}/demo`}
      title="Dotflowy, running live"
      // Copy as Markdown needs the clipboard; the demo's YouTube and Spotify
      // players need playback and fullscreen delegated through this frame.
      allow="clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      // Focus the frame once the app is up, so ⌘K works without a click.
      onLoad={(e) => e.currentTarget.focus()}
      className={cn("block w-full bg-background", className)}
    />
  );
}

export function ResetDemo({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      onClick={onReset}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <RotateCcw aria-hidden className="size-3.5" />
      Reset demo
    </button>
  );
}

/** The demo's sign-up: the moment someone likes it is the moment to ask. */
export function DemoSignUp() {
  return (
    <LinkButton href={APP_URL} size="sm" className="h-7 px-3 text-xs">
      Start free
    </LinkButton>
  );
}

export function LiveDemo({ onClose }: { onClose: () => void }) {
  const [run, setRun] = useState(0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1">
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          {HINTS.map((h) => (
            <li key={h.label} className="flex items-center gap-1.5">
              {h.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
              <span className="ml-0.5">{h.label}</span>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Live. Real speed, not a recording.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_2px_4px_rgb(0_0_0/0.04),0_30px_60px_-20px_rgb(0_0_0/0.22)]">
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <div aria-hidden className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </div>
          <p className="flex-1 truncate text-center text-xs text-muted-foreground">
            Live demo. Edits reset when you leave.
          </p>
          <ResetDemo onReset={() => setRun((n) => n + 1)} />
          <DemoSignUp />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close demo"
            className="-mr-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <DemoFrame run={run} className="h-[34rem] sm:h-[38rem]" />
      </div>
    </div>
  );
}
