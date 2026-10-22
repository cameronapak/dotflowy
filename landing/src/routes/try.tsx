import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { DemoFrame, DemoSignUp, ResetDemo } from "@/components/home/LiveDemo";
import { Logo } from "@/components/Logo";

const TITLE = "Try Dotflowy — live demo";
const DESCRIPTION =
  "Try Dotflowy in your browser with no account. Zoom into bullets, jump with Cmd+K, and check off tasks. Nothing is saved.";

/* The live demo as a whole page. Phones land here from the hero: framed
 * inline, an outliner traps the page's scroll, but here the demo IS the page.
 * Kept out of the index; the homepage is the page to rank. */
export const Route = createFileRoute("/try")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TryPage,
});

function TryPage() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <a
          href="/"
          aria-label="Back to dotflowy.com"
          className="flex items-center gap-1.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          <Logo className="h-4 w-auto" />
        </a>
        <p className="flex-1 truncate text-center text-xs text-muted-foreground">
          <span className="hidden sm:inline">Live demo</span>
        </p>
        <ResetDemo onReset={() => setRun((n) => n + 1)} />
        <DemoSignUp />
      </header>
      <DemoFrame run={run} className="min-h-0 flex-1" />
    </div>
  );
}
