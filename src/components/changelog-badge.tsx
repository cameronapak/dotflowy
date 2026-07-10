import { SparklesIcon } from "lucide-react";

import { useUnseenReleaseCount } from "../data/changelog-cursor";
import { openChangelog } from "./changelog-opener";
import { Button } from "./ui/button";

/**
 * "What's new" — the unread badge, in the header's right cluster (ADR 0046).
 *
 * Present ONLY while there are unseen releases, and its presence IS the signal —
 * the `SpotlightIndicator` / `BookmarkStar` precedent (render nothing when N/A).
 * A solid fill rather than a tinted dot, because the app is grayscale: a
 * low-opacity accent reads as an ordinary ghost-button hover.
 *
 * It never fires for a release the reader already lived through — the cursor
 * seeds silently on first load (`changelog-cursor.ts`). The first badge a user
 * sees defines what the badge means, and a badge that cries wolf is worse than
 * no badge at all.
 *
 * Turning it OFF is not a separate gesture: opening the dialog marks everything
 * read, so the badge disappears on the only interaction it invites.
 */
export function ChangelogBadge() {
  const unseen = useUnseenReleaseCount();
  if (unseen === 0) return null;

  const label = unseen === 1 ? "1 new release" : `${unseen} new releases`;

  return (
    <Button
      variant="default"
      size="sm"
      data-changelog-badge=""
      aria-label={`What's new — ${label}`}
      title={`What's new — ${label}`}
      onClick={() => openChangelog()}
    >
      <SparklesIcon />
      <span className="max-sm:sr-only">What's new</span>
    </Button>
  );
}
