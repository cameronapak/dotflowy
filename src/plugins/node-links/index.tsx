// Node links plugin (ADR 0032). A `[[nodeId]]` token in `node.text` renders as
// a chip showing the TARGET's live text; click zooms to it. Seam A (widget
// token -- the live label needs a subscribing component, see chip.tsx) + Seam B
// (delegated click -> zoom) + Seam H (the `[[` picker). The pure grammar +
// parsing live in src/data/node-links.ts (core-known format, like #tags); the
// backlinks chrome under the zoomed title is CORE (components/backlinks.tsx) --
// this plugin owns only the authoring/reading experience.
//
// Deliberately NOT the `links` plugin: an external `[label](url)` shares almost
// no logic with a node link (no fold/reveal, no unfurl, no bracket editing --
// the chip is a BibleChip-class atom, backspace deletes it whole).

import { CalendarDaysIcon, Link2 } from "lucide-react";

import type { Node } from "../../data/tree";

import { dateSuggestions } from "../../data/date-links";
import {
  linkTargetId,
  linkedNodeLabel,
  NODE_LINK_PATTERN,
} from "../../data/node-links";
import { definePlugin, type MenuTrigger, type WidgetEl } from "../types";
import { NodeLinkChip } from "./chip";

// The atom: `source` is the verbatim `[[id]]` token (what the caret math counts
// and copy reads back); `data-node-link` carries the target id for the Seam-B
// click handler. The core adds `data-src`/`contenteditable`.
function linkWidget(tok: string): WidgetEl {
  return {
    kind: "widget",
    source: tok,
    attrs: { "data-node-link": linkTargetId(tok) },
  };
}

// The `[[` picker's trigger detector (Seam H). The engine assumes a ONE-char
// trigger when it splices (`end = triggerIndex + 1 + query.length`), so this
// match points triggerIndex at the FIRST `[` and folds the second into the
// query -- the replaced span is then exactly `[[<typed>`. Entries strip that
// leading `[` before searching. Unlike tags, the typed query MAY contain
// spaces (node text is multi-word); the menu still dies naturally when nothing
// matches (openWhenEmpty stays false -- ADR 0032: no create-on-no-match), when
// a `]` lands (the token closed or was abandoned), or past a sane length.
function linkMenuMatch(before: string): MenuTrigger | null {
  const triggerIndex = before.lastIndexOf("[[");
  if (triggerIndex === -1) return null;
  const typed = before.slice(triggerIndex + 2);
  if (typed.includes("]") || typed.includes("[")) return null;
  if (typed.length > 60) return null;
  return { query: "[" + typed, triggerIndex };
}

const PICKER_LIMIT = 8;

function optionLabel(node: Node): string {
  const label = linkedNodeLabel(node.text).trim();
  return label.length > 60 ? label.slice(0, 60).trimEnd() + "…" : label;
}

export default definePlugin({
  id: "node-links",
  tokens: [
    {
      id: "node-link",
      pattern: NODE_LINK_PATTERN,
      // After links (0): a `[[id]]` inside a `[label](url)` stays the external
      // link's. Before code (10) so a link pasted into a bullet wins over a
      // stray backtick span. An atom (data-src) but NOT folding -- it never
      // reveals raw source on caret proximity (the interior is an opaque id;
      // revealing it is noise, not editing power -- ADR 0032). Backspace
      // deletes the whole token; that's the unlink story.
      precedence: 5,
      component: NodeLinkChip,
      render: (tok) => linkWidget(tok),
    },
  ],

  // Seam B: click zooms to the target -- a real URL navigation (the `$nodeId`
  // route), so the zoom morph rides for free. A missing target no-ops (the chip
  // already reads "missing link"). Mousedown blocks the editing caret.
  interactions: [
    {
      selector: "[data-node-link]",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        const id = el.dataset.nodeLink;
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        if (!ctx.tree.byId.has(id)) return;
        ctx.nav.zoom(id);
      },
    },
  ],

  // Seam H: the `[[` picker. Matches on each node's flattened reading text
  // (case-insensitive substring, like the `#` menu -- Fuse stays in Cmd+K);
  // recent-first so an empty `[[` offers what you touched last. Excludes the
  // node being edited (no self-link from the picker), mirror instances (link
  // the source -- instances share its content), and blank nodes. No create row:
  // link creation requires an existing target (ADR 0032).
  menus: [
    {
      id: "node-link",
      trigger: "[",
      match: linkMenuMatch,
      entries: (trigger, node, ctx) => {
        const raw = trigger.query.slice(1).trim();
        const q = raw.toLowerCase();
        // Date entries fold INTO this picker (ADR 0038) -- the menu engine's
        // dispatch is first-match-wins on the trigger, so a second `[[` menu
        // would shadow. `dateSuggestions` is the pure core layer
        // (src/data/date-links.ts), so no cross-plugin import into daily.
        // Non-empty only on a date-ish query, pinned above node matches.
        const dates = dateSuggestions(raw).map((s) => ({
          key: `date:${s.key}`,
          render: () => (
            <span className="flex min-w-0 items-center gap-1.5">
              <CalendarDaysIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{s.label}</span>
              <span className="shrink-0 text-muted-foreground">{s.key}</span>
            </span>
          ),
          // Trailing space so the caret lands past the atom (same as below).
          replacement: `[[${s.key}]] `,
        }));
        const matches: Node[] = [];
        for (const n of ctx.tree.byId.values()) {
          if (n.id === node.id) continue;
          if (n.mirrorOf != null) continue;
          const label = linkedNodeLabel(n.text).trim();
          if (!label) continue;
          if (q && !label.toLowerCase().includes(q)) continue;
          matches.push(n);
        }
        matches.sort((a, b) => b.updatedAt - a.updatedAt);
        const nodeEntries = matches.slice(0, PICKER_LIMIT).map((n) => ({
          key: n.id,
          render: () => (
            <span className="flex min-w-0 items-center gap-1.5">
              <Link2
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{optionLabel(n)}</span>
            </span>
          ),
          // Trailing space so the caret lands past the atom and typing
          // continues naturally (the tags-menu convention).
          replacement: `[[${n.id}]] `,
        }));
        return [...dates, ...nodeEntries];
      },
    },
  ],
});
