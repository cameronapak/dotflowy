import { parseInlineMarkdown } from "@dotflowy/changelog-markdown";

import { BUMP_LABEL, type Bump, type Release } from "@/lib/changelog-data";
import { cn } from "@/lib/utils";

function formatDate(date: string): string {
  // `date` is a local calendar day (`YYYY-MM-DD`). Parsed bare it would be read
  // as UTC midnight and render as the previous day west of Greenwich.
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const BUMP_PILL: Record<Bump, string> = {
  major: "bg-foreground text-background",
  minor: "bg-secondary text-secondary-foreground",
  patch: "border border-border bg-transparent text-muted-foreground",
};

function InlineMarkdown({ source }: { source: string }) {
  return (
    <>
      {parseInlineMarkdown(source).map((segment, i) => {
        if (segment.kind === "strong") {
          return (
            <strong key={i} className="font-medium text-foreground">
              {segment.value}
            </strong>
          );
        }
        if (segment.kind === "code") {
          return (
            <code
              key={i}
              className="rounded bg-muted px-1 font-mono text-[0.9em] text-foreground"
            >
              {segment.value}
            </code>
          );
        }
        return <span key={i}>{segment.value}</span>;
      })}
    </>
  );
}

function ReleaseBlock({ release }: { release: Release }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight">
          {release.version}
        </h3>
        <time className="text-xs text-muted-foreground tabular-nums">
          {formatDate(release.date)}
        </time>
      </div>
      <ul className="grid grid-cols-[76px_1fr] gap-x-2 gap-y-2.5">
        {release.entries.map((entry, i) => (
          <li
            key={i}
            className="col-span-2 grid grid-cols-subgrid items-start text-[15px]"
          >
            <span
              className={cn(
                "mt-0.5 inline-flex h-5 items-center justify-center rounded-md px-1.5 text-[11px] font-medium",
                BUMP_PILL[entry.bump],
              )}
            >
              {BUMP_LABEL[entry.bump]}
            </span>
            <span className="min-w-0 whitespace-pre-line text-muted-foreground">
              <InlineMarkdown source={entry.summary} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Newest-first release list. Pass `limit` for the homepage teaser. */
export function ChangelogList({
  releases,
  limit,
}: {
  releases: readonly Release[];
  limit?: number;
}) {
  const shown = limit == null ? releases : releases.slice(0, limit);
  return (
    <div className="flex flex-col gap-10">
      {shown.map((release) => (
        <ReleaseBlock key={release.version} release={release} />
      ))}
    </div>
  );
}
