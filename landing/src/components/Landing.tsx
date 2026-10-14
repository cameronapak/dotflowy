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
import { HeroGraphic } from "@/components/home/HeroGraphic";
import { Footer, GITHUB_URL, Nav } from "@/components/SiteChrome";

/* The dotflowy.com homepage. "One outline for everything. Yours to keep."
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

const PROOF = [
  "Import from Workflowy",
  "MCP server and CLI for your AI agents",
  "Syncs live between browser and phone",
];

function Hero() {
  return (
    <section className="overflow-hidden pt-12 pb-20 sm:pt-16">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-center">
        <div>
          <h1 className="text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl">
            One outline for everything. Yours to keep.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-pretty text-muted-foreground">
            Dotflowy is an outliner for notes, tasks, and ideas. Zoom into any
            bullet to focus on it. Press ⌘K to jump anywhere.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
            <StartFree />
            <p className="text-sm text-muted-foreground">
              Free for 10,000 bullets.
            </p>
          </div>
          <ul className="mt-8 grid gap-2.5 text-sm text-muted-foreground">
            {PROOF.map((p) => (
              <li key={p} className="flex items-start gap-2.5">
                <Dot className="mt-1.5" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:-mr-10">
          <HeroGraphic />
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  "In Workflowy, export your outline as OPML.",
  "In Dotflowy, import the file. Your nesting comes with it.",
  "Keep typing. Enter, Tab, and Shift+Tab work the way you expect.",
];

const FEATURES = [
  "Zoom into any bullet and it becomes the page. The breadcrumb takes you back.",
  "Press ⌘K and type a few letters to jump to any bullet.",
  "Press q to add a thought to today without leaving what you're doing.",
  "Tag as you type, then filter the whole outline by a tag.",
  "Mirror a bullet into more than one place. Edit it once and every copy changes.",
  "Every day gets its own page, with tasks you can check off.",
];

export function Landing() {
  const shipped = recentReleaseCount();
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />

        <Section>
          <H2>Everything is a bullet.</H2>
          <ul className="mt-10 grid gap-5 text-[15px] text-muted-foreground">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <Dot className="mt-2" />
                {f}
              </li>
            ))}
          </ul>
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
          <H2>Let Claude tidy your outline. Keep your secrets.</H2>
          <Lede>
            Connect Claude or any MCP client and approve it once. Ask it to sort
            today&apos;s notes, plan under a bullet, or list your open tasks.
            Its edits appear live, labeled as its own.
          </Lede>
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
                <span>What Claude reads: “Lockbox code [spoiler]”</span>
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
      </main>
      <Footer />
    </div>
  );
}
