import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { Bump, Release } from "../data/changelog-data";

import {
  markChangelogSeen,
  useUnseenReleaseCount,
} from "../data/changelog-cursor";
import { hasBreaking, RELEASES_URL, releases } from "../data/changelog-data";
import { parseInlineMarkdown } from "../data/changelog-markdown";
import { setChangelogOpener } from "./changelog-opener";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * "What's new" — the in-app changelog (ADR 0046).
 *
 * A dialog, mounted once in `__root.tsx` beside the other module-singleton
 * dialogs, reached from three surfaces through `openChangelog()`: the header
 * badge, the More menu, and Cmd+K.
 *
 * Not a route: SPA mode prerenders only the shell, so `/changelog` would be
 * neither crawlable nor shareable, and everything under `AuthGate` is
 * authed-only anyway. The public, feed-carrying changelog is GitHub Releases,
 * linked at the bottom. Not the Tier-3 panel either: `openPanel` is ADR 0031's
 * containment boundary for untrusted Lane-B code, and core chrome must not squat
 * in the room built to hold it.
 *
 * Opening it marks everything read. That is the only write, and it is why the
 * badge can be trusted: the badge and the dialog cannot disagree about what
 * "seen" means.
 */

/** The reader's axis, straight off the bump type — there is no `category` field
 *  to keep honest, because MAJOR/MINOR/PATCH already say this (ADR 0046). */
const BUMP_LABEL: Record<Bump, string> = {
  major: "Changed",
  minor: "Added",
  patch: "Fixed",
};

const BUMP_VARIANT: Record<Bump, "default" | "secondary" | "outline"> = {
  major: "default",
  minor: "secondary",
  patch: "outline",
};

function formatDate(date: string): string {
  // `date` is a local calendar day (`YYYY-MM-DD`). Parsed bare it would be read
  // as UTC midnight and render as the previous day west of Greenwich, so build
  // the Date from its parts (the daily-notes rule).
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A fragment's inline markdown, read rather than printed.
 *
 * React nodes, never `dangerouslySetInnerHTML`: the archive is first-party, but
 * a summary is still text flowing from a file into the DOM, and the segment
 * shape means it can never be anything but text. Bold lands on the foreground
 * colour so it actually reads as emphasis against the muted paragraph.
 */
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
              // No vertical padding: a chip on one line of a wrapped paragraph
              // would otherwise make that line taller than its neighbours.
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

function ReleaseSection({ release }: { release: Release }) {
  return (
    <section className="flex flex-col gap-2" data-testid="changelog-release">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{release.version}</h3>
        <time className="text-xs text-muted-foreground">
          {formatDate(release.date)}
        </time>
      </div>
      {/* One shared badge column, not per-row `flex`: "Changed"/"Added"/"Fixed"
          are different widths, so a flex row starts each summary at its own x
          and the paragraphs stagger. `subgrid` sizes the column once, to the
          widest badge in the release, and every summary hangs off that edge. */}
      <ul className="grid grid-cols-[76px_1fr] gap-x-2 gap-y-2">
        {release.entries.map((entry, i) => (
          <li
            key={i}
            className="col-span-2 grid grid-cols-subgrid items-start text-sm"
          >
            <Badge
              variant={BUMP_VARIANT[entry.bump]}
              className="mt-0.5 justify-center"
            >
              {BUMP_LABEL[entry.bump]}
            </Badge>
            <span className="min-w-0 whitespace-pre-line text-muted-foreground">
              <InlineMarkdown source={entry.summary} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChangelogDialog() {
  const [open, setOpen] = useState(false);
  const unseen = useUnseenReleaseCount();
  /** The unseen count as it was the moment the dialog opened. Read here because
   *  opening MARKS SEEN, which drives `unseen` to 0 before the first paint —
   *  the "Breaking" callout must speak about what the reader hadn't read yet,
   *  not about every major bump in the project's history. */
  const [unseenAtOpen, setUnseenAtOpen] = useState(0);

  useEffect(() => {
    setChangelogOpener(() => {
      setUnseenAtOpen(unseen);
      setOpen(true);
    });
    return () => setChangelogOpener(null);
  }, [unseen]);

  // Mark read on OPEN, not on close: a reader who opens the dialog and hits
  // Escape has still been told. Deferring to close would re-badge them.
  useEffect(() => {
    if (open) markChangelogSeen();
  }, [open]);

  const breaking =
    unseenAtOpen > 0 && hasBreaking(releases.slice(0, unseenAtOpen));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg" data-testid="changelog-dialog">
        <DialogHeader>
          <DialogTitle>What's new</DialogTitle>
          <DialogDescription>
            Every change to Dotflowy, newest first.
          </DialogDescription>
        </DialogHeader>

        {breaking && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            data-testid="changelog-breaking"
          >
            <TriangleAlertIcon className="mt-px size-4 shrink-0" />
            <p>
              Something below is marked <strong>Changed</strong> — it asks
              something of you: relearn a gesture, fix an agent prompt, or
              re-export a file.
            </p>
          </div>
        )}

        <div className="flex max-h-[50vh] scroll-fade flex-col gap-5 overflow-y-auto pr-1">
          {releases.map((release) => (
            <ReleaseSection key={release.version} release={release} />
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              window.open(RELEASES_URL, "_blank", "noopener,noreferrer")
            }
          >
            <ExternalLinkIcon />
            All releases
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
