// Tags plugin (ADR 0018). `#tag` as a plugin. Seam A: the chip render. Seam B:
// the delegated chip click -> filter and right-click -> color picker. Seam F
// (subheader): the active-tag filter bar. Seam G: the `?q=` view transform.
// Seam H: `#` autocomplete. The pure tag layer (parse/normalize/collect/filter)
// stays in src/data/tags.ts and the color side-collection in
// src/data/tag-colors.ts (Seam E); this folder wires them.

import { buildTagFilter, collectAllTags, parseQuery, TAG_PATTERN } from "../../data/tags";
import {
  definePlugin,
  type El,
  type InteractionEvent,
  type MenuTrigger,
  type PluginContext,
} from "../types";
import { Badge } from "@/components/ui/badge";
import { TAG_CHIP_CLASS } from "./tag-classes";
import { TagFilterSubheader } from "./filter-bar";
import { addTagToFilter } from "./use-tag-filter";
import { TagColorMenu } from "./tag-color-menu";

// Inline chips use badgeVariants via TAG_CHIP_CLASS (innerHTML, not <Badge>).
// React surfaces (filter bar, `#` menu) use <Badge variant="outline"> directly.

function tagEl(tok: string): El {
  const name = tok.slice(1);
  return {
    tag: "span",
    attrs: { class: TAG_CHIP_CLASS, "data-tag": name },
    children: [tok],
  };
}

// The `#` autocomplete menu (Seam H). Triggers only when the `#` is at the
// start or after whitespace AND the query so far is all tag chars (so `a#b` or a
// `#` mid-punctuation doesn't open) -- stricter than the engine's default match.
const TAG_CHARS = /^[\p{L}\p{N}_-]+$/u;

function tagMenuMatch(before: string): MenuTrigger | null {
  const triggerIndex = before.lastIndexOf("#");
  if (triggerIndex === -1) return null;
  const prev = before[triggerIndex - 1];
  if (triggerIndex > 0 && prev !== " " && prev !== " ") return null;
  const query = before.slice(triggerIndex + 1);
  if (query.length > 0 && !TAG_CHARS.test(query)) return null;
  return { query, triggerIndex };
}

// Each menu option is the tag's own colored chip (`data-tag` is painted by
// TagColorStyles, same as inline chips).
function tagOption(tag: string) {
  return (
    <Badge variant="outline" className="tag-option" data-tag={tag.slice(1)}>
      {tag}
    </Badge>
  );
}

// Open the color picker at the pointer, routed through the generic overlay host
// (ctx.openOverlay). Shared by chips and filter pills.
function openColorMenu(
  el: HTMLElement,
  ctx: PluginContext,
  e: InteractionEvent,
) {
  const name = el.dataset.tag;
  if (!name) return;
  e.preventDefault();
  ctx.openOverlay(
    <TagColorMenu
      tag={name}
      x={e.clientX}
      y={e.clientY}
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}

export default definePlugin({
  id: "tags",
  tokens: [
    {
      id: "tag",
      pattern: TAG_PATTERN,
      // Last: a `#tag` inside a link or code run is already consumed by those.
      precedence: 20,
      render: (tok) => tagEl(tok),
    },
  ],

  // Seam B: a chip click AND-s the tag into the filter; a chip's mousedown
  // blocks the editing caret (it's inside contentEditable); right-click on a
  // chip OR a filter pill opens the color picker.
  interactions: [
    {
      selector: ".tag[data-tag]",
      blockCaretOnMouseDown: true,
      onClick: (el, _ctx, e) => {
        const name = el.dataset.tag;
        if (!name) return;
        e.preventDefault();
        e.stopPropagation();
        addTagToFilter("#" + name);
      },
      onContextMenu: openColorMenu,
    },
    {
      // Filter pills live outside the contentEditable, so no caret to block and
      // no filter-on-click; only the color picker.
      selector: "[data-tag-pill][data-tag]",
      onContextMenu: openColorMenu,
    },
  ],

  // Seam G: the `#tag` filter, expressed as a global view transform. Active only
  // when the `?q=` carries tags; prunes the tree to matches + their ancestor
  // context (the pure walk stays in src/data/tags.ts). It's handed the composed
  // `isHidden` so completed subtrees drop out without this layer knowing about
  // completion. The core wires the result in as the `filter` prop (still
  // core-rendered for now -- see ADR 0018's "still core-wired" note).
  viewTransforms: [
    {
      id: "tag-filter",
      buildFilter: (index, ctx, isHidden) => {
        const tags = parseQuery(ctx.search.q as string | undefined);
        if (!tags.length) return null;
        const filter = buildTagFilter(index, ctx.rootId, tags, isHidden);
        return {
          ...filter,
          emptyMessage: `No nodes tagged ${tags.join(" ")} here.`,
        };
      },
    },
  ],

  subheaderSlots: [
    {
      id: "tag-filter",
      render: () => <TagFilterSubheader />,
    },
  ],

  // Seam H: `#` autocomplete over existing tags (read live from the tree). New
  // tags are made by just finishing typing -- no "create" row, so the menu only
  // opens when at least one existing tag matches (openWhenEmpty stays false).
  // Picking inserts the full tag + a trailing space (it's "finished").
  menus: [
    {
      id: "tag",
      trigger: "#",
      match: tagMenuMatch,
      entries: (trigger, node, ctx) => {
        const q = trigger.query.toLowerCase();
        // Exclude the node being edited: its text already holds the in-progress
        // tag (live tree), so the corpus must be OTHER nodes' tags or the menu
        // would offer the brand-new tag you're typing as a match for itself.
        const all = collectAllTags(ctx.tree, node.id);
        const matches = q
          ? all.filter((t) => t.slice(1).toLowerCase().includes(q))
          : all;
        return matches.slice(0, 8).map((tag) => ({
          key: tag,
          render: () => tagOption(tag),
          replacement: tag + " ",
        }));
      },
    },
  ],
});
