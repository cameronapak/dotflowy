// Tags plugin (ADR 0018). `#tag` as a plugin. Seam A: the chip render. Seam B:
// the delegated chip click -> filter and right-click -> color picker. The pure
// tag layer (parse/normalize/collect/filter) lives in ./tags.ts and the
// color side-collection in ./tag-colors.ts (Seam E); this file is the
// plugin that wires them.

import { buildTagFilter, collectAllTags, TAG_PATTERN } from "./tags";
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

function tagOption(tag: string) {
  return (
    <span className="tag-option" data-tag={tag.slice(1)}>
      {tag}
    </span>
  );
}

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
      precedence: 20,
      render: (tok) => tagEl(tok),
    },
  ],

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
      selector: ".tag-pill[data-tag]",
      onContextMenu: openColorMenu,
    },
  ],

  viewTransforms: [
    {
      id: "tag-filter",
      buildFilter: (index, ctx, isHidden) =>
        ctx.search.length
          ? buildTagFilter(index, ctx.rootId, ctx.search, isHidden)
          : null,
    },
  ],

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
