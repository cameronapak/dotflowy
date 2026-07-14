import type { VariantProps } from "class-variance-authority";

import { Star } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { Logo } from "@/components/Logo";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

// Single source of truth for the outbound links. Handle is `cameronapak`
// (matches the README's GitHub badges).
const APP_URL = "https://app.dotflowy.com";
const GITHUB_URL = "https://github.com/cameronapak/dotflowy";
// The waitlist endpoint lives on the app Worker, which allows dotflowy.com
// (and localhost:3100 for dev) cross-origin. Overridable for local testing.
const API_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_API_URL ??
  APP_URL;

/** A link styled as a button. Links are `<a>` elements (correct semantics),
 * not Base UI Buttons rendering an anchor. */
function LinkButton({
  href,
  external,
  variant,
  size,
  className,
  children,
}: {
  href: string;
  external?: boolean;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {children}
    </a>
  );
}

/** The bullet dot, the page's structural through-line. Solid, like the app's. */
function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-foreground/70",
        className,
      )}
    />
  );
}

function Nav() {
  return (
    <header className="border-b border-border/60">
      <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-6">
        <a href="/" className="flex items-center">
          <Logo className="h-5 w-auto" />
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LinkButton href={GITHUB_URL} external variant="ghost" size="sm">
            <Star className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </LinkButton>
          <LinkButton href={APP_URL} variant="outline" size="sm">
            Sign in
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

/** Email capture into the app Worker's public POST /api/waitlist (invite-only
 * alpha: the waitlist is the front door). Duplicate emails are a silent ok
 * server-side, so the success state is honest either way. */
function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) return;
    setState("busy");
    try {
      const res = await fetch(`${API_URL}/api/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, source: "landing" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="flex h-11 items-center font-mono text-sm text-foreground">
        You're on the list. We'll email you an invite.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-md flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
          className="h-11 w-full rounded-lg border border-border bg-background px-3.5 text-[15px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <button
          type="submit"
          disabled={state === "busy"}
          className={cn(
            buttonVariants({ size: "lg" }),
            "h-11 shrink-0 px-5 text-[15px]",
          )}
        >
          {state === "busy" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {state === "error" && (
        <p className="text-sm text-destructive">
          Couldn't join the waitlist. Try again.
        </p>
      )}
    </form>
  );
}

// One bullet per stage of the job: capture, retrieve, shape.
const POINTS = [
  "Capture a thought in one keystroke, before it slips away.",
  "Find it again with tags, filters, and instant search.",
  "Shape ideas like they're physical — drag, nest, zoom into anything.",
];

function Hero() {
  return (
    <section className="mx-auto w-full max-w-2xl px-6 pt-20 pb-24 sm:pt-28">
      <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">
        Room to <span className="text-brand-blue">think</span>.
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
        Get everything out of your head, shape it when you're ready, and find it
        when it matters. Dotflowy is a calm, fast outliner that keeps up with
        the way you think.
      </p>

      <ul className="mt-8 space-y-2.5 text-[15px] text-muted-foreground">
        {POINTS.map((p) => (
          <li key={p} className="flex items-start gap-2.5">
            {/* mt centers the dot on the first text line when a bullet wraps */}
            <Dot className="mt-2" />
            {p}
          </li>
        ))}
      </ul>

      <p className="mt-6 font-mono text-xs text-muted-foreground">
        Open source. Real-time sync. Export everything, anytime.
      </p>

      <div className="mt-10">
        <WaitlistForm />
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          In private alpha · have an invite?{" "}
          <a
            href={APP_URL}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Sign in
          </a>
        </p>
      </div>
    </section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 text-sm">
          <Logo className="h-4 w-auto" />
          <span className="font-mono text-muted-foreground">
            — an open-source Workflowy alternative
          </span>
        </div>
        <nav className="flex items-center gap-5 text-sm text-muted-foreground">
          <a href={APP_URL} className="transition-colors hover:text-foreground">
            Open app
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <span className="text-muted-foreground/70">© {year}</span>
        </nav>
      </div>
      {/* Nominative-fair-use disclaimer: naming Workflowy is lawful, but state
       * plainly that we're independent and unaffiliated. */}
      <div className="mx-auto w-full max-w-2xl px-6 pb-10">
        <p className="text-xs leading-relaxed text-muted-foreground/70">
          Workflowy is a trademark of its respective owner. Dotflowy is an
          independent, open-source project and is not affiliated with, sponsored
          by, or endorsed by Workflowy.
        </p>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
      </main>
      <Footer />
    </div>
  );
}
