import type { ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { ArrowRight, Sparkle, Star } from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";
import { HeroOutlineDemo } from "./HeroOutlineDemo";

// Single source of truth for the outbound links. Handle is `cameronapak`
// (matches the README's GitHub badges).
const APP_URL = "https://app.dotflowy.com";
const GITHUB_URL = "https://github.com/cameronapak/dotflowy";

function Section({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mx-auto w-full max-w-5xl px-6">{children}</div>
    </section>
  );
}

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
      className={cn("size-1.5 shrink-0 rounded-full bg-foreground/70", className)}
    />
  );
}

/** A single kicker, used once in the hero. One named kicker is voice; an eyebrow
 * on every section is AI grammar, so the rest of the page goes without. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
      <Dot />
      {children}
    </span>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
        <a
          href="/"
          className="flex items-center gap-2 font-mono text-[15px] font-semibold tracking-tight"
        >
          <Dot className="size-2.5" />
          dotflowy
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LinkButton href={GITHUB_URL} external variant="ghost" size="sm">
            <Star className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </LinkButton>
          <LinkButton
            href={APP_URL}
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
          >
            Sign in
          </LinkButton>
          <LinkButton href={APP_URL} size="sm">
            Get started
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <Section className="pt-16 pb-20 sm:pt-24 sm:pb-28">
      <div className="mx-auto max-w-2xl">
        <Eyebrow>Open-source outliner</Eyebrow>
        <h1 className="mt-5 text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">
          Workflowy,
          <br />
          but <span className="text-brand-blue">yours</span>.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
          A fast, keyboard-first outliner you can actually own. Nest anything,
          zoom into any bullet, and build on it with plugins. Open source, and
          syncing in real time.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <LinkButton href={APP_URL} size="lg" className="h-11 px-5 text-[15px]">
            Get started free
            <ArrowRight className="size-4" />
          </LinkButton>
          <LinkButton
            href={GITHUB_URL}
            external
            variant="outline"
            size="lg"
            className="h-11 px-5 text-[15px]"
          >
            <Star className="size-4" />
            Star on GitHub
          </LinkButton>
        </div>
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          Free and open source · your data, exportable
        </p>
      </div>

      <div className="mx-auto mt-14 max-w-3xl">
        <HeroOutlineDemo />
      </div>
    </Section>
  );
}

/** Each feature carries a small, product-native artifact instead of an identical
 * body block, so the three don't read as a generated grid. */
type Feature = { title: string; body: string; artifact: ReactNode };

const FEATURES: Feature[] = [
  {
    title: "Zoom in. Everything else disappears.",
    body: "Infinite nesting and one-click zoom into any bullet. Collapse the noise, focus a single branch, and keyboard your way through the whole thing.",
    artifact: (
      <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <Dot className="size-1" />
        Home
        <span className="text-muted-foreground/50">›</span>
        <span className="text-foreground/80">Ship dotflowy.com</span>
      </span>
    ),
  },
  {
    title: "Open source, and truly yours.",
    body: "Your outline lives in your own per-user store and syncs live across devices. Export anytime. Extend it with plugins. The core is just the start.",
    artifact: (
      <span className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
        {["MIT licensed", "self-hostable", "plugins"].map((t) => (
          <span
            key={t}
            className="rounded-md border border-border bg-secondary px-1.5 py-0.5"
          >
            {t}
          </span>
        ))}
      </span>
    ),
  },
  {
    title: "More than bullets.",
    body: "Daily notes, colored #tags, rich links, and to-dos are built in. Quietly, staying out of your way until the moment you reach for them.",
    artifact: (
      <span className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="grid size-3.5 place-items-center rounded-[3px] border border-muted-foreground/50 text-[9px] text-foreground/70">
            ✓
          </span>
          to-do
        </span>
        <span className="rounded-full bg-brand-blue/12 px-1.5 py-0.5 text-brand-blue">
          #focus
        </span>
        <span className="text-foreground/70 underline decoration-brand-blue/40 underline-offset-2">
          a link
        </span>
      </span>
    ),
  },
];

function Features() {
  return (
    <Section className="border-t border-border/60 py-20 sm:py-24">
      <ul className="grid gap-x-10 gap-y-12 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <div className="flex items-start gap-2.5">
              <Dot className="mt-2" />
              <h3 className="text-lg font-medium tracking-tight text-balance">
                {f.title}
              </h3>
            </div>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              {f.body}
            </p>
            <div className="mt-4">{f.artifact}</div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** A small, static outline showing the one thing that makes AI honest here: a
 * node an agent added wears the same quiet muted sparkle the app uses, so you
 * always know what's yours. AI is a helper, not the star. No gradient, no glow. */
function AuthorBeat() {
  return (
    <Section className="border-t border-border/60 py-20 sm:py-24">
      <div className="grid items-center gap-10 sm:grid-cols-2 sm:gap-14">
        <div className="max-w-md">
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            AI can help. You stay the author.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Connect Claude or any MCP agent and let it capture and organize
            alongside you. Everything it adds is marked, so you can always tell
            your own thinking from a hand it lent you.
          </p>
          <p className="mt-4 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <Sparkle className="size-3.5" />
            = added by an assistant
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 sm:p-6">
          <ul className="space-y-1.5 text-[15px]">
            <li className="flex items-center gap-2.5">
              <Dot />
              <span>Plan the week</span>
            </li>
            <li className="flex items-center gap-2.5 pl-6">
              <Dot />
              <Sparkle className="size-4 shrink-0 text-muted-foreground" />
              <span>Draft the Q3 goals</span>
            </li>
            <li className="flex items-center gap-2.5 pl-6">
              <Dot />
              <span>Book the offsite venue</span>
            </li>
          </ul>
          <p className="mt-4 border-t border-border/60 pt-3 font-mono text-[11px] text-muted-foreground">
            <Sparkle className="mr-1 inline size-3 align-[-2px]" />
            Created by Claude · 2h ago
          </p>
        </div>
      </div>
    </Section>
  );
}

function ClosingCTA() {
  return (
    <Section className="border-t border-border/60 py-24 text-center sm:py-32">
      <h2 className="mx-auto max-w-xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Start your outline.
      </h2>
      <p className="mx-auto mt-5 max-w-md text-lg text-muted-foreground">
        Free, open source, no lock-in. Your first bullet is one click away.
      </p>
      <div className="mt-8 flex justify-center">
        <LinkButton href={APP_URL} size="lg" className="h-12 px-6 text-base">
          Get started free
          <ArrowRight className="size-4" />
        </LinkButton>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
        <span>Then hit</span>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
        <span>to jump anywhere in it</span>
      </div>
    </Section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 font-mono text-sm">
          <Dot className="size-2" />
          <span className="font-semibold">dotflowy</span>
          <span className="text-muted-foreground">
            — an open-source outliner
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
    </footer>
  );
}

export function Landing() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main>
        <Hero />
        <Features />
        <AuthorBeat />
        <ClosingCTA />
      </main>
      <Footer />
    </div>
  );
}
