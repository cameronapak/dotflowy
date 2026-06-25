import { ChevronRight, HomeIcon, MoreHorizontal } from "lucide-react";
import type { Node } from "../../data/tree";
import { Button } from "../ui/button";

/**
 * The breadcrumb trail above a zoomed node. Mirrors Workflowy: when the trail
 * is deep, the middle ancestors collapse into a single "…" control that reveals
 * the hidden crumbs in a dropdown, keeping the row on one line. We always keep
 * the first ancestor after Home (top-level context) and the immediate parent;
 * everything between them collapses. Each crumb truncates with ellipsis when
 * its text is long.
 */
const LEADING = 1;
const TRAILING = 2;

export function BreadcrumbTrail({
  trail,
  rootId,
  onNavigate,
}: {
  trail: Node[];
  rootId: string | null;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  // Only collapse when at least two crumbs would be hidden — folding a single
  // crumb into a "…" saves no space.
  const collapse = trail.length > LEADING + TRAILING + 1;
  const lead = collapse ? trail.slice(0, LEADING) : trail;
  const hidden = collapse ? trail.slice(LEADING, trail.length - TRAILING) : [];
  const tail = collapse ? trail.slice(trail.length - TRAILING) : [];

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {/* Zooming out: the current root is the pivot (title -> list item). */}
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={() => {
          if (rootId === null) return;
          onNavigate(null, rootId);
        }}
      >
        <HomeIcon />
      </Button>
      {rootId &&
        lead.map((ancestor) => (
          <Crumb
            key={ancestor.id}
            ancestor={ancestor}
            rootId={rootId}
            onNavigate={onNavigate}
          />
        ))}
      {rootId && collapse && (
        <CollapsedCrumbs
          hidden={hidden}
          rootId={rootId}
          onNavigate={onNavigate}
        />
      )}
      {rootId &&
        tail.map((ancestor) => (
          <Crumb
            key={ancestor.id}
            ancestor={ancestor}
            rootId={rootId}
            onNavigate={onNavigate}
          />
        ))}
    </nav>
  );
}

function Crumb({
  ancestor,
  rootId,
  onNavigate,
}: {
  ancestor: Node;
  rootId: string;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  return (
    <span className="crumb">
      <ChevronRight className="sep" size={13} strokeWidth={2.5} />
      <button
        type="button"
        className="crumb-link"
        onClick={() => onNavigate(ancestor.id, rootId)}
      >
        {ancestor.text || "Untitled"}
      </button>
    </span>
  );
}

/**
 * The collapsed middle of a deep trail. The "…" button reveals the hidden
 * ancestors in a dropdown on hover or keyboard focus (CSS-driven via
 * :hover / :focus-within, so no open/close state to manage).
 */
function CollapsedCrumbs({
  hidden,
  rootId,
  onNavigate,
}: {
  hidden: Node[];
  rootId: string;
  onNavigate: (toRootId: string | null, pivot: string) => void;
}) {
  return (
    <span className="crumb crumb-collapsed">
      <ChevronRight className="sep" size={13} strokeWidth={2.5} />
      <button
        type="button"
        className="crumb-ellipsis"
        aria-label="Show hidden breadcrumbs"
        aria-haspopup="menu"
      >
        <MoreHorizontal size={14} strokeWidth={2} />
      </button>
      <div className="crumb-dropdown" role="menu">
        {hidden.map((ancestor) => (
          <button
            key={ancestor.id}
            type="button"
            role="menuitem"
            className="crumb-dropdown-item"
            onClick={() => onNavigate(ancestor.id, rootId)}
          >
            {ancestor.text || "Untitled"}
          </button>
        ))}
      </div>
    </span>
  );
}
