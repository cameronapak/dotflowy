import { FocusIcon } from "lucide-react";
import { Button } from "./ui/button";
import { setSpotlightEnabled, useSpotlightEnabled } from "./spotlight-mode";

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
 * "Today" badge uses) and is unmissable even at icon-only size. On desktop the
 * "Spotlight" label spells it out; on mobile (a tight header that must not crowd
 * the breadcrumb) the label collapses to an SR-only span and the solid fill
 * alone carries the meaning.
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
      size="sm"
      data-spotlight-indicator=""
      aria-pressed
      aria-label="Turn off spotlight mode"
      title="Spotlight mode is on — click to turn off"
      onClick={() => setSpotlightEnabled(false)}
    >
      <FocusIcon />
      <span className="max-sm:sr-only">Spotlight</span>
    </Button>
  );
}
