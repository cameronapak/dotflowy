// Tags plugin (ADR 0018). `#tag` as a plugin. Seam A: the chip render. Seam B:
// the delegated chip click -> filter and right-click -> color picker. The pure
// tag layer (parse/normalize/collect/filter) stays in src/data/tags.ts and the
// color side-collection in ./tag-colors.ts (Seam E); this file is the
// plugin that wires them. The filter view-transform (Seam G) and `#` autocomplete
// (Seam H) are still core-wired pending their dedicated refactors (see ADR 0018
// implementation notes).

import { buildTagFilter, collectAllTags, TAG_PATTERN } from "../../data/tags";
import {
  definePlugin,
  type El,
  type InteractionEvent,
  type MenuTrigger,
  type PluginContext,
} from "../types";
import { TagColorMenu } from "./tag-color-menu";

// Tag chips borrow the Badge pill shape, applied as an inline utility string
// (the chip is injected via innerHTML, not rendered as <Badge>). A neutral
// outline by default (the `.tag` rule, border-border); a chosen color fills it
// via the generated stylesheet keyed by `data-tag` (ADR 0016). `.tag` is also
// the delegated click handler's hook.
const TAG_CLASS =
  "tag rounded-full px-1.5 py-0.5 text-[0.85em] font-medium cursor-pointer";

function tagEl(tok: string): El {
  const name = tok.slice(1);
  return {
    tag: "span",
    attrs: { class: TAG_CLASS, "data-tag": name },
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

// Each menu option is the tag's own colored chip (`.tag-option` + `data-tag` is
// painted by the generated TagColorStyles stylesheet, same as inline chips).
function tagOption(tag: string) {
  return (
    <span className="tag-option" data-tag={tag.slice(1)}>
      {tag}
    </span>
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
      onClick: (el, ctx, e) => {
        const name = el.dataset.tag;
        if (!name) return;
        e.preventDefault();
        e.stopPropagation();
        ctx.nav.filterTag("#" + name);
      },
      onContextMenu: openColorMenu,
    },
    {
      // Filter pills live outside the contentEditable, so no caret to block and
      // no filter-on-click; only the color picker.
      selector: ".tag-pill[data-tag]",
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
      buildFilter: (index, ctx, isHidden) =>
        ctx.search.length
          ? buildTagFilter(index, ctx.rootId, ctx.search, isHidden)
          : null,
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
      entries: (trigger, _node, ctx) => {
        const q = trigger.query.toLowerCase();
        const all = collectAllTags(ctx.tree);
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
