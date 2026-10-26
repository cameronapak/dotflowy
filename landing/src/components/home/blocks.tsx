import type { ReactNode } from "react";

import { AppPage, Row } from "@/components/home/app-parts";
import { APP_URL, LinkButton } from "@/components/SiteChrome";
import { releases } from "@/lib/changelog-data";
import { cn } from "@/lib/utils";

/** Releases shipped in the 30 days before the newest one: a countable proof
 * of momentum, computed at build time from the changelog archive. */
export function recentReleaseCount(days = 30) {
  const newest = releases[0]?.date;
  if (!newest) return 0;
  const cutoff = new Date(newest).getTime() - days * 86_400_000;
  return releases.filter((r) => new Date(r.date).getTime() >= cutoff).length;
}

export function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-foreground/70",
        className,
      )}
    />
  );
}

export type MockRow = {
  text: ReactNode;
  depth?: number;
  task?: "open" | "done";
  collapsed?: boolean;
  /** A row the mock wants the eye on: the app's mirror-blue dot. */
  accent?: boolean;
  /** Created by an agent: the provenance sparkle. */
  agent?: boolean;
  dim?: boolean;
};

/** An HTML stand-in for the editor, built from the measured app parts. */
export function OutlineMock({
  title,
  crumbs,
  rows,
  className,
  footer,
}: {
  title?: ReactNode;
  crumbs?: string[];
  rows: MockRow[];
  className?: string;
  footer?: ReactNode;
}) {
  return (
    <div className={cn("text-[17px]", className)}>
      <AppPage
        crumbs={crumbs ?? []}
        toolbar={false}
        title={title}
        className="bg-card shadow-[0_16px_40px_-16px_rgb(0_0_0/0.14)] dark:shadow-none"
      >
        {rows.map((r, i) => (
          <Row
            key={i}
            depth={r.depth}
            task={r.task}
            collapsed={r.collapsed}
            accent={r.accent}
            agent={r.agent}
            className={r.dim ? "opacity-35" : undefined}
          >
            {r.text}
          </Row>
        ))}
        {footer}
      </AppPage>
    </div>
  );
}

export type Faq = { q: string; a: string };

/** Real <details>: every answer is in the prerendered HTML, works without JS,
 * and mirrors the FAQPage JSON-LD exactly. */
export function FaqList({ items }: { items: Faq[] }) {
  return (
    <div className="divide-y divide-border border-y border-border">
      {items.map((f) => (
        <details key={f.q} className="group py-4">
          <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
            {f.q}
            <span
              aria-hidden
              className="mt-0.5 text-muted-foreground transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-pretty text-muted-foreground">
            {f.a}
          </p>
        </details>
      ))}
    </div>
  );
}

export function faqJsonLd(items: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export const APP_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Dotflowy",
  url: "https://dotflowy.com",
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Web",
  description:
    "An outliner for notes, tasks, and ideas. Zoom into any bullet, jump anywhere with Cmd+K, import from Workflowy, export OPML or Markdown, and connect AI agents over MCP.",
  offers: [
    { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
    { "@type": "Offer", name: "Unlimited", price: "5", priceCurrency: "USD" },
    { "@type": "Offer", name: "Founding", price: "99", priceCurrency: "USD" },
  ],
  author: { "@type": "Person", name: "Cameron Pak" },
  publisher: {
    "@type": "Organization",
    "@id": "https://dotflowy.com/#publisher",
    name: "FAITH TOOLS SOFTWARE SOLUTIONS, LLC",
    url: "https://dotflowy.com",
    email: "support@dotflowy.com",
  },
};

/** The three plans as one compact, scannable block. */
export function PricingCompact({ className }: { className?: string }) {
  const plans = [
    {
      name: "Free",
      price: "$0",
      per: "",
      line: "10,000 bullets. At the limit nothing locks: you can still read, edit, and export.",
    },
    {
      name: "Unlimited",
      price: "$5",
      per: "/mo or $48/yr",
      line: "No bullet limit. Adds AI agents over MCP and the CLI. Your subscription funds Dotflowy's development.",
      accent: true,
    },
    {
      name: "Founding",
      price: "$99",
      per: "for 3 years",
      line: "Unlimited for 3 years, paid once, to back Dotflowy early. 50 seats. Renews after 3 years unless you cancel.",
    },
  ];
  return (
    <div
      className={cn(
        "divide-y divide-border rounded-xl border border-border bg-card",
        className,
      )}
    >
      {plans.map((p) => (
        <div
          key={p.name}
          className="grid gap-1 p-5 sm:grid-cols-[9rem_1fr] sm:gap-6"
        >
          <div>
            <p
              className={cn(
                "text-sm font-medium",
                p.accent ? "text-brand-blue" : "text-muted-foreground",
              )}
            >
              {p.name}
            </p>
            <p className="mt-0.5">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">
                {p.price}
              </span>
              {p.per && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {p.per}
                </span>
              )}
            </p>
          </div>
          <p className="text-[15px] leading-relaxed text-pretty text-muted-foreground sm:pt-1">
            {p.line}
          </p>
        </div>
      ))}
    </div>
  );
}

export function StartFree({ label = "Start free" }: { label?: string }) {
  return (
    <LinkButton href={APP_URL} size="lg" className="h-11 px-5 text-[15px]">
      {label}
    </LinkButton>
  );
}

export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className="border-t border-border/60">
      <div
        className={cn(
          "mx-auto w-full max-w-2xl px-6 py-20 sm:py-24",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
      {children}
    </h2>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-pretty text-muted-foreground">
      {children}
    </p>
  );
}
