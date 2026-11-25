// Personal plugins (ADR 0095): reviewed, compiled-in code that renders the
// account's agent-authored definitions. A definition is data; no generated
// code runs here.
//
// Off means off: `isActive` is false until the server says this paid,
// eligible account opted in, so the registry leaves out every token, slot,
// subheader, and command below. Only the Cmd+K opt-in stays reachable, and
// only for an eligible account. Token patterns list the account's installed
// component names, so unknown `:name[…]` or `::name` text never matches and
// stays plain text. Stored text is never rewritten.

import { PuzzleIcon } from "@/lib/icons";

import type {
  CommandChild,
  PersonalPluginComponent,
} from "../../data/personal-plugins";
import type { Node } from "../../data/tree";

import {
  decorate,
  getSelectionRange,
  readSource,
  setCaretOffset,
} from "../../components/inline-code";
import { activeEditable } from "../../components/wrap";
import {
  blockComponentPattern,
  inlineComponentPattern,
  isTone,
  parseBlockComponent,
  parseInlineComponent,
  type Tone,
} from "../../data/comark";
import { getNodeActionBridge } from "../../data/command-bridge";
import { capture } from "../../data/history";
import { appendChild } from "../../data/mutations";
import { runStructural } from "../../data/structural";
import { getTreeIndex } from "../../data/tree-store";
import { isRevealed } from "../token-kit";
import {
  type CommandSpec,
  definePlugin,
  type GlobalActionSpec,
  type PluginContext,
  type WidgetProps,
} from "../types";
import {
  canOptIn,
  getInstalled,
  isActive,
  setOptIn,
  subscribe,
  useInstalled,
} from "./store";
import {
  BoardView,
  PersonalChip,
  PersonalPanel,
  PersonalSubheader,
  ProgressView,
} from "./views";

function componentFor(
  name: string,
  kind: PersonalPluginComponent["kind"],
  from = getInstalled(),
): { pluginId: string; component: PersonalPluginComponent } | null {
  for (const item of from)
    for (const component of item.definition.components ?? [])
      if (component.name === name && component.kind === kind)
        return { pluginId: item.definition.id, component };
  return null;
}

const namesOf = (kind: PersonalPluginComponent["kind"]) =>
  getInstalled().flatMap((item) =>
    (item.definition.components ?? [])
      .filter((c) => c.kind === kind)
      .map((c) => c.name),
  );

const toneOf = (
  attr: string | true | undefined,
  fallback: Tone | undefined,
): Tone => (isTone(attr) ? attr : (fallback ?? "neutral"));

// --- `/` commands: templates the core inserts. No plugin code runs. ----------

/** Rebuilt from the installed definitions; the registry re-reads it whenever
 *  the store notifies. */
const commands: CommandSpec[] = [];
function rebuildCommands() {
  commands.length = 0;
  for (const item of getInstalled())
    for (const [i, command] of (item.definition.commands ?? []).entries())
      commands.push({
        id: `personal-${item.definition.id}-${i}`,
        label: command.label,
        description:
          command.description ?? `Personal plugin · ${item.definition.name}`,
        icon: PuzzleIcon,
        keywords: [item.definition.name, "plugin"],
        available: () => true,
        // Inserts at the caret, so Cmd+K (no caret) leaves it out.
        caretScoped: true,
        run: (nodeId, ctx) => {
          insertTemplate(nodeId, command.insert, ctx);
          if (command.children?.length)
            scaffoldChildren(nodeId, command.children);
        },
      });
}
subscribe(rebuildCommands);

/** A `::block` template leads the bullet (its text becomes the title); any
 *  other template goes in at the caret, with a space before it if needed. */
function insertTemplate(nodeId: string, insert: string, ctx: PluginContext) {
  const el = activeEditable();
  if (!el) return;
  const source = readSource(el);
  const range = getSelectionRange(el) ?? {
    start: source.length,
    end: source.length,
  };
  let next: string;
  let caret: number;
  if (insert.startsWith("::")) {
    const rest = source.trim();
    next = rest ? `${insert} ${rest}` : insert;
    caret = next.length;
  } else {
    const before = source.slice(0, range.start);
    const head =
      before && !/\s$/.test(before) ? `${before} ${insert}` : before + insert;
    next = head + source.slice(range.end);
    caret = head.length;
  }
  ctx.mutations.onTextChange(nodeId, next);
  decorate(el, next, caret, false);
  setCaretOffset(el, caret);
}

/** Create the command's child bullets in one undoable structural batch. A
 *  mirror's children live on its source. A bullet that already has children
 *  keeps them and gets none, so a template never mixes into existing notes. */
function scaffoldChildren(nodeId: string, children: readonly CommandChild[]) {
  runStructural(() => {
    const index = getTreeIndex();
    const node = index.byId.get(nodeId);
    if (!node) return;
    const parentId = node.mirrorOf ?? node.id;
    if (index.childrenByParent.get(parentId)?.length) return;
    capture(index, nodeId, null, { label: "create" });
    const build = (
      under: string,
      items: readonly { text: string; children?: readonly CommandChild[] }[],
    ) => {
      let prev: string | null = null;
      for (const item of items) {
        prev = appendChild(under, prev, item.text);
        if (item.children?.length) build(prev, item.children);
      }
    };
    build(parentId, children);
  });
}

// --- Block components ----------------------------------------------------------

/** A child of a `::name` bullet whose component hides children. The zoom
 *  root's own children stay visible, so zooming in is how you edit them. */
function hiddenByComponent(node: Node, rootId: string | null): boolean {
  if (!isActive() || !node.parentId || node.parentId === rootId) return false;
  const parent = getTreeIndex().byId.get(node.parentId);
  if (!parent?.text.startsWith("::")) return false;
  const block = parseBlockComponent(parent.text);
  return !!(
    block && componentFor(block.name, "block")?.component.hidesChildren
  );
}

function BlockRow({
  node,
  getCtx,
}: {
  node: Node;
  getCtx: () => PluginContext;
}) {
  const installed = useInstalled();
  const block = parseBlockComponent(node.text);
  const found = block && componentFor(block.name, "block", installed);
  if (!block || !found) return null;
  const tone = toneOf(block.attrs.get("tone"), found.component.tone);
  switch (found.component.view) {
    case "progress":
      return <ProgressView node={node} tone={tone} />;
    case "board":
      return <BoardView node={node} getCtx={getCtx} />;
    default:
      return null;
  }
}

function InlineChip(props: WidgetProps) {
  return (
    <PersonalChip
      name={String(props.name)}
      label={String(props.label)}
      tone={toneOf(String(props.tone), undefined)}
      plugin={String(props.plugin)}
    />
  );
}

const MONO = "font-mono text-[0.88em]";

export default definePlugin({
  id: "personal",
  isActive,
  chromeChanged: (notify) => subscribe(notify),
  commands,
  globalActions: () => [
    ...(canOptIn()
      ? [
          {
            id: "enable",
            label: "Enable personal plugins (beta)",
            description:
              "Let your own agent add views and commands to your Dotflowy over MCP. Only you see them.",
            icon: PuzzleIcon,
            keywords: ["plugin", "personal", "agent", "mcp", "beta"],
            run: () => void setOptIn(true),
          } satisfies GlobalActionSpec,
        ]
      : []),
    ...(isActive() ? getInstalled() : []).flatMap(
      (item): GlobalActionSpec[] => {
        const panel = item.definition.panel;
        if (!panel) return [];
        return [
          {
            id: `open-${item.definition.id}`,
            label: `Open ${panel.title}`,
            description: `Personal plugin · ${item.definition.name}`,
            icon: PuzzleIcon,
            keywords: ["plugin", item.definition.name],
            run: () =>
              getNodeActionBridge()
                ?.getCtx()
                .openPanel(<PersonalPanel id={item.definition.id} />),
          },
        ];
      },
    ),
  ],
  subheaderSlots: [
    { id: "personal-subheader", render: () => <PersonalSubheader /> },
  ],
  viewTransforms: [
    {
      id: "personal-hides-children",
      hidesNode: (node, ctx) => hiddenByComponent(node, ctx.rootId),
    },
  ],
  tokens: [
    {
      id: "personal-block",
      // The `::name{attrs}` prefix of a block bullet. Folds to `::name` until
      // the caret touches it; the full source is always what is stored.
      get pattern() {
        return blockComponentPattern(namesOf("block"));
      },
      precedence: 2,
      folds: true,
      render: (tok, view) => {
        const block = parseBlockComponent(tok);
        if (!block) return tok;
        if (isRevealed(view) || tok === `::${block.name}`)
          return {
            tag: "span",
            attrs: { class: `${MONO} text-(--tag-purple-fg)` },
            children: [tok],
          };
        return {
          tag: "span",
          attrs: {
            class: `cursor-text ${MONO} text-(--tag-purple-fg)`,
            contenteditable: "false",
            "data-src": tok,
            "data-src-len": tok.length,
            title: tok,
          },
          children: [`::${block.name}`],
        };
      },
    },
    {
      id: "personal-inline",
      // `:name[label]{attrs}` for an installed inline component only.
      get pattern() {
        return inlineComponentPattern(namesOf("inline"));
      },
      precedence: 3,
      folds: true,
      component: InlineChip,
      render: (tok, view) => {
        const parsed = parseInlineComponent(tok);
        const found = parsed && componentFor(parsed.name, "inline");
        if (!parsed || !found) return tok;
        if (isRevealed(view))
          return { tag: "span", attrs: { class: MONO }, children: [tok] };
        return {
          kind: "widget",
          source: tok,
          props: {
            name: parsed.name,
            label: parsed.label,
            tone: toneOf(parsed.attrs.get("tone"), found.component.tone),
            plugin: found.pluginId,
          },
        };
      },
    },
  ],
  slots: [
    {
      id: "personal-block-row",
      position: "row:body",
      render: (node, getCtx) =>
        node.text.startsWith("::") ? (
          <BlockRow node={node} getCtx={getCtx} />
        ) : null,
    },
    {
      id: "personal-block-title",
      position: "title:body",
      render: (node, getCtx) =>
        node.text.startsWith("::") ? (
          <BlockRow node={node} getCtx={getCtx} />
        ) : null,
    },
  ],
});
