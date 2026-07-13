import { PilcrowIcon } from "lucide-react";

import type { NodeKind } from "../data/schema";

/**
 * The glyph inside a row's `.bullet` button: a dot for a bullet or task, a
 * pilcrow for a paragraph (ADR 0045).
 *
 * The pilcrow IS the dot -- same button, same handlers, same coarse-pointer
 * hitbox, same hover ring. Only the glyph changes, so a paragraph's mark still
 * zooms on click and reorders on press-and-drag (ADR 0029: the dot is the sole
 * touch zoom target, and the pilcrow inherits that job wholesale). Both glyphs
 * are a `<span>` carrying `data-has-children`/`data-collapsed`, because the
 * collapsed-ring rule selects `.bullet:has(span[data-has-children][data-collapsed])`.
 */
export function BulletGlyph({
  kind,
  completed,
  hasChildren,
  collapsed,
}: {
  kind: NodeKind;
  completed: boolean;
  hasChildren: boolean;
  collapsed: boolean;
}) {
  if (kind === "paragraph") {
    return (
      <span
        className="bullet-pilcrow"
        data-has-children={hasChildren}
        data-collapsed={collapsed}
        aria-hidden="true"
      >
        <PilcrowIcon size={14} strokeWidth={2.25} />
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
 * The zoomed page title's pilcrow (`title:before-text`), for a paragraph that is
 * the current view root. Muted and non-interactive -- there is nothing to zoom
 * into from here, and without it a zoomed paragraph would be indistinguishable
 * from a zoomed bullet, leaving `/paragraph` with no visible state (ADR 0045).
 */
export function TitlePilcrow({ kind }: { kind: NodeKind }) {
  if (kind !== "paragraph") return null;
  return (
    <span className="title-pilcrow" aria-hidden="true">
      <PilcrowIcon size={18} strokeWidth={2.25} />
    </span>
  );
}
