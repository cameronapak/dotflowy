import { FocusIcon } from "lucide-react";

import { setSpotlightEnabled, useSpotlightEnabled } from "./spotlight-mode";
import { Button } from "./ui/button";

/**
 * Header indicator for spotlight focus mode (ADR 0033). Appears in the header's
 * right cluster ONLY while spotlight is on, and doubles as the off-switch.
 *
 * Why a header control and not the subheader band: spotlight exists to REDUCE
 * visual noise, so a persistent subheader banner (a full extra row, colliding
 * with the tag filter) would fight the feature's own intent. A compact chip
 * costs zero vertical space, sidesteps the subheader entirely, and mirrors
 * BookmarkStar's "render nothing when N/A" precedent.
 *
 * Why appears-only-when-on: at rest (no caret) the pure-CSS dim shows nothing,
 * so there is otherwise no passive signal that the mode is active. A
 * present-vs-absent chip is a bigger perceptual delta than lit-vs-dim, so the
 * chip's mere existence reads as "you're in spotlight." Turning the mode ON
 * stays in the More menu + Cmd+K; this surface is awareness + off only.
 *
 * Responsive: a SOLID fill is the awareness signal on both breakpoints. The app
 * is grayscale (`--primary` is chroma-0), so a 10%-opacity tint would read as an
 * ordinary ghost-button hover — invisible. A solid `--primary` pill (dark fill,
 * light glyph) is the grayscale system's "active" idiom (same emphasis the daily
 * "Today" badge uses) and is unmissable even at icon-only size. Under the
 * header-toggle rule (ADR 0050), solid is correct here for a second reason:
 * spotlight ALTERS the view (everything dims), so it earns the loud treatment —
 * where the filter magnifier's open-but-empty state stays muted. The chip is
 * icon-only on every breakpoint: the "Spotlight" label stays an SR-only span
 * (the `title` tooltip gives pointer users the text). A visible desktop label
 * distracted and crowded the breadcrumb + other header controls, and the solid
 * fill already carries the meaning, so the label earns no pixels.
 *
 * No toast on click: the chip vanishing + the outline no longer dimming on the
 * next focus is feedback enough.
 */
export function SpotlightIndicator() {
  const enabled = useSpotlightEnabled();
  if (!enabled) return null;

  return (
    <Button
      variant="default"
      size="icon-sm"
      data-spotlight-indicator=""
      aria-pressed
      aria-label="Turn off spotlight mode"
      title="Spotlight mode is on — click to turn off"
      onClick={() => setSpotlightEnabled(false)}
    >
      <FocusIcon />
      <span className="sr-only">Spotlight</span>
    </Button>
  );
}
