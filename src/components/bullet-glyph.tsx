import { AlignLeftIcon } from "lucide-react";

import type { NodeKind } from "../data/schema";

/**
 * The glyph inside a row's `.bullet` button: a dot for a bullet or task, a
 * paragraph glyph (an align-left mark) for a paragraph (ADR 0045), and a bar
 * for a quote (ADR 0079).
 *
 * Every glyph IS the dot -- same button, same handlers, same coarse-pointer
 * hitbox, same hover ring. Only the glyph changes, so a paragraph's mark and a
 * quote's bar still zoom on click and reorder on press-and-drag (ADR 0029: the
 * dot is the sole touch zoom target). The quote bar stretches the button to the
 * quote's own lines, which makes a taller target, not a second one. A quote is
 * derived from the text, not a Kind, so it outranks paragraph Kind here;
 * numbered Kind keeps its number handle even for quoted text. All glyphs are a `<span>` carrying
 * `data-has-children`/`data-collapsed`, because the collapsed-ring rule selects
 * `.bullet:has(span[data-has-children][data-collapsed])`.
 */
export function BulletGlyph({
  kind,
  quote,
  completed,
  hasChildren,
  collapsed,
  ordinal,
}: {
  kind: NodeKind;
  quote: boolean;
  completed: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  ordinal?: number;
}) {
  // Numbered Kind keeps its handle even when its text is a quotation.
  if (kind === "numbered") {
    return (
      <span
        className="bullet-number"
        data-has-children={hasChildren}
        data-collapsed={collapsed}
        aria-hidden="true"
      >
        {ordinal}.
      </span>
    );
  }
  if (quote) {
    return (
      <span
        className="bullet-quote"
        data-has-children={hasChildren}
        data-collapsed={collapsed}
        aria-hidden="true"
      />
    );
  }

  if (kind === "paragraph") {
    return (
      <span
        className="bullet-paragraph"
        data-has-children={hasChildren}
        data-collapsed={collapsed}
        aria-hidden="true"
      >
        <AlignLeftIcon size={14} strokeWidth={2.25} />
      </span>
    );
  }

  return (
    <span
      className="bullet-dot"
      data-completed={completed}
      data-has-children={hasChildren}
      data-collapsed={collapsed}
    />
  );
}

/**
 * The zoomed page title's glyph (`title:before-text`) for a paragraph or quote
 * that is the current view root. Muted and non-interactive -- there is nothing
 * to zoom into from here, and without it a zoomed paragraph or quote would be
 * indistinguishable from a zoomed bullet (ADR 0045, ADR 0079).
 */
export function TitleGlyph({
  kind,
  quote,
  ordinal,
}: {
  kind: NodeKind;
  quote: boolean;
  ordinal?: number;
}) {
  if (kind === "numbered")
    return (
      <span
        className="title-number"
        style={{ width: `${String(ordinal).length + 1}ch` }}
      >
        {ordinal}.
      </span>
    );
  if (quote) return <span className="title-quote" aria-hidden="true" />;
  if (kind !== "paragraph") return null;
  return (
    <span className="title-paragraph" aria-hidden="true">
      <AlignLeftIcon size={18} strokeWidth={2.25} />
    </span>
  );
}
