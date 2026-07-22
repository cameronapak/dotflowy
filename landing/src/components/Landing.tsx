import type { VariantProps } from "class-variance-authority";

import { Play, Star } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Logo } from "@/components/Logo";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

// Single source of truth for the outbound links. Handle is `cameronapak`
// (matches the README's GitHub badges).
const APP_URL = "https://app.dotflowy.com";
const GITHUB_URL = "https://github.com/cameronapak/dotflowy";
const GITHUB_API = "https://api.github.com/repos/cameronapak/dotflowy";

function useGithubStars() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(GITHUB_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        if (!cancelled && typeof data?.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return stars;
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
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-foreground/70",
        className,
      )}
    />
  );
}

function Nav() {
  const stars = useGithubStars();
  return (
    <header>
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <a href="/" className="flex items-center">
          <Logo className="h-5 w-auto" />
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LinkButton
            href={GITHUB_URL}
            external
            variant="ghost"
            size="sm"
            className="min-h-10 min-w-10 gap-1.5 px-2.5 sm:min-w-0 sm:pr-2.5 sm:pl-2"
          >
            <Star className="size-4" />
            <span className="hidden sm:inline">Star on GitHub</span>
            {stars != null && (
              <span className="text-muted-foreground tabular-nums">
                {stars.toLocaleString()}
              </span>
            )}
          </LinkButton>
          <LinkButton
            href={APP_URL}
            variant="outline"
            size="sm"
            className="min-h-10 px-3"
          >
            Sign in
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

// One bullet per stage of the job: capture, retrieve, shape.
const POINTS = [
  "Quick capture without leaving what you're doing.",
  "Find it later with tags, filters, and Cmd+K.",
  "Drag, nest, zoom, mirror. Thoughts you can move.",
];

const VIDEO_ID = "S07dI6pIr_Q";
const YT_ORIGINS = [
  "https://www.youtube-nocookie.com",
  "https://www.google.com",
];

/** YouTube facade: the self-hosted poster + a play button, and nothing from
 * YouTube until the visitor clicks — then the real iframe drops in with
 * autoplay, so one click still starts playback. Hover/focus preconnects to
 * the player origins so the handshake is done by click time. */
function DemoVideo() {
  const [playing, setPlaying] = useState(false);
  const warmed = useRef(false);

  const warm = () => {
    if (warmed.current) return;
    warmed.current = true;
    for (const href of YT_ORIGINS) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = href;
      document.head.append(link);
    }
  };

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-card shadow-[0_16px_40px_-12px_rgb(0_0_0/0.12)] outline outline-1 outline-black/10 dark:shadow-none dark:outline-white/10">
      {playing ? (
        <iframe
          className="absolute inset-0 size-full"
          src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&rel=0`}
          title="Dotflowy demo video"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          aria-label="Play the demo video"
          onClick={() => {
            warm();
            setPlaying(true);
          }}
          onPointerEnter={warm}
          onFocus={warm}
          className="group absolute inset-0 block size-full cursor-pointer"
        >
          <img
            src="/demo-thumb.jpg"
            alt="Dotflowy demo — overview of the outliner"
            width={1280}
            height={720}
            loading="eager"
            fetchPriority="high"
            className="size-full object-cover object-center"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform duration-200 group-hover:scale-105 group-active:scale-[0.96] motion-reduce:transition-none">
              {/* Optical centering: the triangle reads centered nudged right */}
              <Play className="ml-1 size-6 fill-current" />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

/** The hero is set like an outline: the H1 is the root bullet, the sub-copy
 * and CTA its children, and the screenshot below is the zoomed node. */
function Hero() {
  return (
    <section className="pt-14 pb-24 sm:pt-20">
      <div className="mx-auto w-full max-w-2xl px-6">
        <div className="relative pl-7 sm:pl-9">
          {/* The root bullet — the same solid dot the app draws on every row. */}
          <span
            aria-hidden
            className="absolute top-[0.42em] left-0 size-3 rounded-full bg-foreground text-5xl sm:size-3.5 sm:text-6xl"
          />
          <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">
            Free up your mind.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
            Get your thoughts and tasks out. Organize them later, or don't.
          </p>
          <div className="mt-9">
            <LinkButton
              href={APP_URL}
              size="lg"
              className="h-11 px-5 text-[15px]"
            >
              Start free
            </LinkButton>
            <p className="mt-3 text-xs text-muted-foreground">
              Already have an account?{" "}
              <a
                href={APP_URL}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Sign in
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* The zoomed node: the app itself, breaking out of the text column.
       * 16:9 so the exported poster's crop is unambiguous. */}
      <Reveal delay={120} className="mx-auto mt-14 w-full max-w-5xl px-6">
        <DemoVideo />
      </Reveal>

      <div className="mx-auto w-full max-w-2xl px-6">
        <ul className="mt-10 grid gap-6 text-[15px] text-muted-foreground">
          {POINTS.map((p) => (
            <li key={p} className="flex items-start gap-2.5">
              {/* mt centers the dot on the first text line when a bullet wraps */}
              <Dot className="mt-2" />
              {p}
            </li>
          ))}
        </ul>
        <p className="mt-8 text-xs text-muted-foreground">
          Open source Workflowy alternative. Real-time sync. Export anytime.
        </p>
      </div>
    </section>
  );
}

/** Differentiated beats from the product demo — one idea each, no feature dump. */
const BEATS = [
  {
    title: "Hide what AI shouldn't see.",
    body: "Wrap text in a spoiler. You can still find it. Agents see it redacted.",
  },
  {
    title: "One thought, many places.",
    body: "Mirror a bullet into today, a project, or a week. Edit it once and it updates everywhere it lives.",
  },
  {
    title: "When it's too much, spotlight one line.",
    body: "Cmd+K, turn on Spotlight. The rest of the outline dims so you can finish the thought in front of you.",
  },
];

function OnlyHere() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-14 px-6 py-20 sm:py-24">
        {BEATS.map((beat, i) => (
          <Reveal key={beat.title} delay={i * 80}>
            <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              {beat.title}
            </h2>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-pretty text-muted-foreground">
              {beat.body}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/** Scroll-reveal: opacity + a small translateY, once, on entering the viewport.
 * Strong ease-out curve, ≤300ms. Honours prefers-reduced-motion (shows at once,
 * no movement) and never blocks — content is always in the DOM for crawlers. */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        transitionDelay: shown ? `${delay}ms` : "0ms",
      }}
      className={cn(
        "transition-[opacity,transform] duration-300 motion-reduce:transition-none",
        // Hint the compositor before the reveal; drop it once shown so we don't
        // keep a GPU layer alive for the life of the page.
        shown
          ? "translate-y-0 opacity-100"
          : "translate-y-2 opacity-0 will-change-[opacity,transform]",
        className,
      )}
    >
      {children}
    </div>
  );
}

type Tier = {
  name: string;
  price: ReactNode;
  tagline: string;
  features: string[];
  // One quiet label above the name — a first-party note, not a fabricated stat.
  label?: string;
  // The emphasized tier (Unlimited): brand-blue accent + ring.
  accent?: boolean;
  // The limited offer (Founding): a distinct muted fill.
  distinct?: boolean;
  // Founding's honest renewal disclosure (a hard requirement — Stripe can't
  // pre-schedule non-renewal).
  note?: string;
};

const TIERS: Tier[] = [
  {
    name: "Free",
    price: (
      <span className="text-4xl font-semibold tracking-tight tabular-nums">
        $0
      </span>
    ),
    tagline: "Keep every thought. Pay nothing.",
    features: [
      "The full editor: daily notes, tags, filters, real-time sync.",
      "10,000 nodes to fill (Workflowy's free plan allows only 100 new nodes a month).",
      "Import from Workflowy (OPML), or export as OPML or Markdown. Your outline stays yours.",
      "Hit the cap and nothing locks. Keep reading, editing, and exporting. Upgrade only when you need more room.",
    ],
  },
  {
    name: "Unlimited",
    label: "Recommended",
    accent: true,
    price: (
      <div>
        <span className="text-4xl font-semibold tracking-tight tabular-nums">
          $5
        </span>
        <span className="ml-1.5 text-sm text-muted-foreground">/mo</span>
        <p className="mt-1.5 text-xs text-muted-foreground">
          or $48/yr. That's $4/mo, billed yearly.
        </p>
      </div>
    ),
    tagline: "When your outline outgrows Free.",
    features: [
      "Everything in Free.",
      "Unlimited nodes. No ceiling on how much you hold.",
      "AI agents: connect Claude and others to your outline over MCP.",
    ],
  },
  {
    name: "Founding",
    label: "Limited · 50 seats",
    distinct: true,
    price: (
      <div>
        <span className="text-4xl font-semibold tracking-tight tabular-nums">
          $99
        </span>
        <span className="ml-1.5 text-sm text-muted-foreground">
          for 3 years
        </span>
        <p className="mt-1.5 text-xs text-muted-foreground">
          ≈ <span className="tabular-nums">$2.75</span>/mo. Save{" "}
          <span className="tabular-nums">$81</span> vs Unlimited at{" "}
          <span className="tabular-nums">$5</span>/mo.
        </p>
      </div>
    ),
    tagline: "Back Dotflowy early. Lock in three years.",
    features: [
      "Everything in Unlimited.",
      "One payment covers three full years of Unlimited.",
    ],
    note: "Renews after 3 years unless you cancel. Cancel anytime.",
  },
];

function PricingCard({ tier }: { tier: Tier }) {
  return (
    <div
      className={cn(
        "rounded-xl border p-6 sm:p-7",
        tier.distinct ? "bg-secondary" : "bg-card",
        tier.accent
          ? "border-brand-blue/40 ring-brand-blue/20 ring-1"
          : "border-border",
      )}
    >
      {tier.label && (
        <p
          className={cn(
            "text-[11px] font-medium tracking-wider uppercase",
            tier.accent ? "text-brand-blue" : "text-muted-foreground",
          )}
        >
          {tier.label}
        </p>
      )}
      <h3
        className={cn(
          "mt-1 text-lg font-semibold tracking-tight",
          tier.accent && "text-brand-blue",
        )}
      >
        {tier.name}
      </h3>
      <div className="mt-3">{tier.price}</div>
      <p className="mt-3 text-[15px] text-muted-foreground">{tier.tagline}</p>
      <ul className="mt-5 space-y-2.5 text-[15px] text-muted-foreground">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            {/* mt centers the dot on the first text line when a line wraps */}
            <Dot className="mt-2" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {tier.note && (
        <p className="mt-5 border-t border-border/60 pt-4 text-xs leading-relaxed text-muted-foreground">
          {tier.note}
        </p>
      )}
    </div>
  );
}

/** Pricing. Three tiers, one emphasized (Unlimited), Founding as the distinct
 * limited offer. Signups are open, so the page's single action is: start free. */
function Pricing() {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto w-full max-w-2xl px-6 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Honest pricing.
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-pretty text-muted-foreground">
            Start free with room to spare. Upgrade only when you outgrow it.
            Import from Workflowy, or export as OPML or Markdown on any plan.
            Your outline stays yours.
          </p>
        </Reveal>

        <div className="mt-10 flex flex-col gap-4">
          {TIERS.map((tier, i) => (
            <Reveal key={tier.name} delay={i * 70}>
              <PricingCard tier={tier} />
            </Reveal>
          ))}
        </div>

        <Reveal delay={TIERS.length * 70} className="mt-8">
          <LinkButton
            href={APP_URL}
            size="lg"
            className="h-11 px-5 text-[15px]"
          >
            Start free
          </LinkButton>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center text-sm">
          <Logo className="h-4 w-auto" />
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
          <a
            href={`${APP_URL}/terms`}
            className="transition-colors hover:text-foreground"
          >
            Terms
          </a>
          <a
            href={`${APP_URL}/privacy`}
            className="transition-colors hover:text-foreground"
          >
            Privacy
          </a>
        </nav>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-6">
        <a
          href="https://tools.launchllama.co?utm_source=badge&utm_medium=referral"
          target="_blank"
          rel="noreferrer noopener"
        >
          <img
            src="https://speaktechenglish.com/wp-content/uploads/2026/04/Screenshot_2026-04-09_at_17.40.44-removebg-preview.png"
            alt="Featured on Launch Llama"
            width={200}
            height={50}
          />
        </a>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-6">
        <p className="text-xs text-muted-foreground/70">
          FAITH TOOLS SOFTWARE SOLUTIONS, LLC © {year}
        </p>
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
        <OnlyHere />
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}
