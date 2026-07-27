// Inline `@agent` / `@dot` plugin (ADR 0059). Seams A (widget + trailing
// play/stop), B (play → ask / open Add agent; stop → cancel), C (`/ask` tags
// only), H (`@` picker), K (`is:ai`). No hosted AI / fireAgent / Lunora runs.

import { BotIcon } from "lucide-react";

import {
  ensureAgentMention,
  AGENT_MENTION,
  isAiNode,
} from "../../data/agent-mention";
import { runAgentPlay, runAgentStop } from "../../data/agent-play-run";
import { getTreeIndex } from "../../data/tree-store";
import { resolveNodeId } from "../token-kit";
import {
  definePlugin,
  type InteractionEvent,
  type MenuTrigger,
  type PluginContext,
  type WidgetEl,
} from "../types";
import { AgentChip } from "./chip";

function agentWidget(tok: string): WidgetEl {
  return {
    kind: "widget",
    source: tok,
    attrs: { "data-agent-chrome": true },
  };
}

function agentMenuMatch(before: string): MenuTrigger | null {
  const triggerIndex = before.lastIndexOf("@");
  if (triggerIndex === -1) return null;
  const prev = before[triggerIndex - 1];
  if (triggerIndex > 0 && !/\s/.test(prev ?? "")) return null;
  const query = before.slice(triggerIndex + 1);
  const q = query.toLowerCase();
  if (
    query.length > 0 &&
    !/^agent$/i.test(query) &&
    !/^dot$/i.test(query) &&
    !"agent".startsWith(q) &&
    !"dot".startsWith(q)
  ) {
    return null;
  }
  return { query, triggerIndex };
}

function onPlayClick(
  el: HTMLElement,
  _ctx: PluginContext,
  e: InteractionEvent,
) {
  const nodeId = resolveNodeId(el);
  if (!nodeId) return;
  e.preventDefault();
  e.stopPropagation();
  runAgentPlay(nodeId);
}

function onStopClick(
  el: HTMLElement,
  _ctx: PluginContext,
  e: InteractionEvent,
) {
  const nodeId = resolveNodeId(el);
  if (!nodeId) return;
  e.preventDefault();
  e.stopPropagation();
  runAgentStop(nodeId);
}

/** Tag only — user presses play when ready. */
function runAsk(nodeId: string, ctx: PluginContext) {
  const node = getTreeIndex().byId.get(nodeId);
  if (!node) return;
  ensureAgentMention(nodeId, node.text, ctx.mutations.onTextChange);
}

/** Play creates ask (or opens Add agent); while busy, hotkey cancels. */
function onPlayHotkey(nodeId: string, _ctx: PluginContext) {
  const kind = runAgentPlay(nodeId);
  if (kind === "noop-busy") runAgentStop(nodeId);
}

export default definePlugin({
  id: "agent",

  tokens: [
    {
      id: "agent-mention",
      pattern: AGENT_MENTION,
      // After node-links (5) / daily date (6), before code (10).
      precedence: 7,
      component: AgentChip,
      render: (tok) => agentWidget(tok),
    },
  ],

  interactions: [
    {
      selector: "[data-agent-play]",
      blockCaretOnMouseDown: true,
      onClick: onPlayClick,
    },
    {
      selector: "[data-agent-stop]",
      blockCaretOnMouseDown: true,
      onClick: onStopClick,
    },
  ],

  commands: [
    {
      id: "ask",
      label: "Ask agent",
      description: "Tag @agent on this bullet — press play when ready",
      icon: BotIcon,
      keywords: ["ask", "agent", "dot", "ai", "llm"],
      available: () => true,
      run: (id, ctx) => {
        runAsk(id, ctx);
      },
    },
  ],

  keymap: [
    {
      id: "agent-play",
      hotkey: "Mod+Shift+Enter",
      run: (id, ctx) => {
        onPlayHotkey(id, ctx);
      },
    },
  ],

  menus: [
    {
      id: "agent-mention",
      trigger: "@",
      match: agentMenuMatch,
      openWhenEmpty: true,
      entries: (trigger) => {
        const q = trigger.query.toLowerCase();
        return [
          ...(!q || "agent".startsWith(q)
            ? [
                {
                  key: "agent",
                  render: () => <span className="text-sm">@agent</span>,
                  replacement: "@agent ",
                },
              ]
            : []),
          ...(!q || "dot".startsWith(q)
            ? [
                {
                  key: "dot",
                  render: () => <span className="text-sm">@dot</span>,
                  replacement: "@dot ",
                },
              ]
            : []),
        ];
      },
    },
  ],

  filterOperators: [
    {
      key: "is",
      values: ["ai"],
      description:
        "Part of an AI exchange (@agent/@dot mention or agent-origin answer)",
      predicate: (node) => isAiNode(node),
    },
  ],
});
