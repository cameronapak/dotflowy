import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ProvenanceTip, Spoiler } from "@/components/home/app-parts";
import {
  Dot,
  FaqList,
  H2,
  Lede,
  OutlineMock,
  PricingCompact,
  Section,
  StartFree,
  recentReleaseCount,
  type Faq,
} from "@/components/home/blocks";
import { ClientRow } from "@/components/home/clients";
import { FeatureRows } from "@/components/home/features";
import { HeroGraphic } from "@/components/home/HeroGraphic";
import { LiveDemo } from "@/components/home/LiveDemo";
import { Footer, GITHUB_URL, LinkButton, Nav } from "@/components/SiteChrome";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/* The dotflowy.com homepage. "An outliner that moves as fast as you think."
 * Audience: the evaluator, someone who already keeps an outline (often in
 * Workflowy), is wary of lock-in, and is curious about AI. Every line states a
 * checkable fact; no adjectives the product has to live up to. Everything is
 * in the prerendered HTML at full opacity: no scroll-reveal gating. */

export const FAQ: Faq[] = [
  {
    q: "What counts as a bullet?",
    a: "Every line in your outline: bullets, tasks, and paragraphs. Free includes 10,000.",
  },
  {
    q: "Can I export my outline?",
    a: "Yes. Export as OPML or Markdown on every plan, even after you reach the free limit.",
  },
  {
    q: "What can AI agents see?",
    a: "Only your outline, and only after you approve the connection. Text in a spoiler reaches them redacted. Their edits are labeled as theirs. AI agents need Unlimited or Founding.",
  },
  {
    q: "Is Dotflowy open source?",
    a: "Yes. The code is on GitHub under the O'Saasy license: read it, change it, and self-host it on Cloudflare. The one limit is selling it as a competing hosted service.",
  },
  {
    q: "Is there a phone app?",
    a: "Dotflowy runs in any modern browser on desktop and phone, and syncs live between them. There's no App Store app; you can add it to your home screen.",
  },
  {
    q: "Can I share an outline or collaborate?",
    a: "Not yet. Each outline belongs to one person.",
  },
];

function Hero() {
  // The live demo loads the whole app, so it waits for a visitor to ask. It
  // opens below the hero, which stays put, so nothing above it shifts.
  const [demo, setDemo] = useState(false);
  const demoRef = useRef<HTMLDivElement>(null);
  const tryRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const showDemo = () =>
    demoRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  useEffect(() => {
    if (demo) {
      opened.current = true;
      showDemo();
    } else if (opened.current) {
      // Closing returns focus to the button that opened it.
      tryRef.current?.focus();
    }
  }, [demo]);
  return (
    <section className="overflow-hidden pt-6 pb-20 sm:pt-8">
      <div className="mx-auto grid w-full max-w-5xl gap-12 px-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-center">
        <div>
          <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">
            An outliner that moves as fast as you think.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-pretty text-muted-foreground">
            Dotflowy keeps your notes, tasks, and ideas in one nested outline.
            Get everything out of your head, then find it the moment it matters.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-3">
            <StartFree />
            <button
              ref={tryRef}
              type="button"
              onClick={() => (demo ? showDemo() : setDemo(true))}
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "hidden h-11 px-5 text-[15px] md:inline-flex",
              )}
            >
              <Play aria-hidden />
              Try the live demo
            </button>
            {/* Framed inline, an outliner traps a phone's scroll; the demo
                gets the whole screen instead. */}
            <LinkButton
              href="/try"
              variant="outline"
              size="lg"
              className="h-11 px-5 text-[15px] md:hidden"
            >
              <Play aria-hidden />
              Try the live demo
            </LinkButton>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Generous free plan. No credit card required.
          </p>
        </div>
        <div>
          <HeroGraphic />
        </div>
      </div>
      {demo && (
        <div ref={demoRef} className="mx-auto mt-16 w-full max-w-5xl px-6">
          <LiveDemo onClose={() => setDemo(false)} />
        </div>
      )}
    </section>
  );
}

const STEPS = [
  "In Workflowy, export your outline as OPML.",
  "In Dotflowy, import the file. Your nesting comes with it.",
  "Keep typing. Enter, Tab, and Shift+Tab work the way you expect.",
];

export function Landing() {
  const shipped = recentReleaseCount();
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />

        <Section className="max-w-5xl">
          <H2>Everything is a bullet.</H2>
          <FeatureRows />
        </Section>

        <Section>
          <H2>Coming from Workflowy?</H2>
          <ol className="mt-10 grid gap-6">
            {STEPS.map((step, i) => (
              <li key={step} className="flex items-start gap-4">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-sm font-medium tabular-nums">
                  {i + 1}
                </span>
                <p className="pt-0.5 text-[15px] text-muted-foreground">
                  {step}
                </p>
              </li>
            ))}
          </ol>
        </Section>

        <Section>
          <p className="text-brand-blue mb-3 text-sm font-medium">
            AI agents · Unlimited and Founding
          </p>
          <H2>Let your AI agent tidy your outline. Keep your secrets.</H2>
          <Lede>
            Connect ChatGPT, Claude, Cursor, or any MCP client and approve it
            once. Ask it to sort today&apos;s notes, plan under a bullet, or
            list your open tasks. Its edits appear live, labeled with its name.
          </Lede>
          <ClientRow className="mt-8" />
          <OutlineMock
            className="mt-10"
            crumbs={["Projects", "Apartment move #home"]}
            rows={[
              { text: "Movers: get 3 quotes", task: "open" },
              { text: "Grouped by room", agent: true },
              { text: "Kitchen: 6 boxes, fragile", depth: 1 },
              { text: "Office: desk breaks down first", depth: 1 },
              {
                text: (
                  <>
                    Lockbox code <Spoiler>||4417||</Spoiler>
                  </>
                ),
              },
            ]}
            footer={
              <div className="mt-[0.9em] flex flex-wrap items-center gap-[0.6em] border-t border-border pt-[0.8em] text-[0.8em] text-muted-foreground">
                <ProvenanceTip className="text-[1em]" />
                <span>What your agent reads: “Lockbox code [spoiler]”</span>
              </div>
            }
          />
          <ul className="mt-8 grid gap-3 text-[15px] text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <Dot className="mt-2" />
              Text in a spoiler reaches agents redacted. You can still search
              it.
            </li>
            <li className="flex items-start gap-2.5">
              <Dot className="mt-2" />
              Prefer the terminal? The same tools come as the dotflowy CLI on
              npm.
            </li>
            <li className="flex items-start gap-2.5">
              <Dot className="mt-2" />
              <span>
                Setup, tools, and security:{" "}
                <a
                  href="/mcp"
                  className="text-foreground underline underline-offset-2"
                >
                  read the MCP guide
                </a>
                .
              </span>
            </li>
          </ul>
        </Section>

        <Section>
          <H2>Dotflowy is open source.</H2>
          <div className="mt-8 flex items-start gap-4">
            <img
              src="/cameron-pak.png"
              alt="Cameron Pak"
              width={48}
              height={48}
              className="size-12 rounded-full"
            />
            <p className="text-[15px] leading-relaxed text-pretty text-muted-foreground">
              Built in the open by Cameron Pak and contributors. {shipped}{" "}
              releases in the last 30 days:{" "}
              <a
                href="/changelog"
                className="text-foreground underline underline-offset-2"
              >
                read the changelog
              </a>{" "}
              or the{" "}
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground underline underline-offset-2"
              >
                code on GitHub
              </a>
              .
            </p>
          </div>
        </Section>

        <Section>
          <H2>Pricing</H2>
          <Lede>Every plan has the full editor, import, and export.</Lede>
          <PricingCompact className="mt-10" />
          <div className="mt-8">
            <StartFree />
          </div>
        </Section>

        <Section>
          <H2>Questions</H2>
          <div className="mt-10">
            <FaqList items={FAQ} />
          </div>
        </Section>

        <Section>
          <H2>Start with one bullet.</H2>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <StartFree />
            <LinkButton
              href="/try"
              variant="outline"
              size="lg"
              className="h-11 px-5 text-[15px]"
            >
              <Play aria-hidden />
              Try the live demo
            </LinkButton>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Generous free plan. No credit card required.
          </p>
        </Section>
      </main>
      <Footer />
    </div>
  );
}
