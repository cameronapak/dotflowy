// Inline `@agent` plugin (ADR 0059). Seams A (widget: pill + trailing
// play/stop/loader), B (play → Run popover; stop → cancel), C (`/ask`),
// D (`Mod+Shift+Enter`), H (`@` picker), K (`is:ai`).

import { SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import {
  ensureAgentMention,
  fireAgent,
  stopAgent,
} from "../../data/agent-fire";
import { AGENT_MENTION, isAiNode } from "../../data/agent-mention";
import { getAgentRunForQuestion } from "../../data/agent-runs";
import { isLunoraSyncEnabled } from "../../data/flags";
import { resolveNodeId } from "../token-kit";
import {
  definePlugin,
  type InteractionEvent,
  type MenuTrigger,
  type PluginContext,
  type WidgetEl,
} from "../types";
import { AgentChip } from "./chip";
import { AgentRunPopover } from "./run-popover";

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
  if (
    query.length > 0 &&
    !/^agent$/i.test(query) &&
    !"agent".startsWith(query.toLowerCase())
  ) {
    return null;
  }
  return { query, triggerIndex };
}

/** Anchor the Run confirm near the play control (or the row) for keyboard/`/ask`. */
function anchorRectForNode(nodeId: string): DOMRect {
  const el =
    document.querySelector(`li[data-node-id="${nodeId}"] [data-agent-play]`) ??
    document.querySelector(`li[data-node-id="${nodeId}"] .node-text`) ??
    document.querySelector(`[data-node-id="${nodeId}"]`);
  return el?.getBoundingClientRect() ?? new DOMRect(24, 24, 0, 0);
}

/** Two-step fire (ADR 0059): every surface opens the confirm popover. */
function openRunPopoverForNode(nodeId: string, ctx: PluginContext) {
  if (getAgentRunForQuestion(nodeId)?.status === "running") return;

  const rect = anchorRectForNode(nodeId);
  ctx.openOverlay(
    <AgentRunPopover
      nodeId={nodeId}
      x={rect.left}
      y={rect.bottom + 6}
      onClose={() => ctx.openOverlay(null)}
      onRun={() => {
        ctx.openOverlay(null);
        void fireAgent(nodeId);
      }}
    />,
  );
}

function openRunPopover(
  el: HTMLElement,
  ctx: PluginContext,
  e: InteractionEvent,
) {
  const nodeId = resolveNodeId(el);
  if (!nodeId) return;
  e.preventDefault();
  e.stopPropagation();
  openRunPopoverForNode(nodeId, ctx);
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
  void stopAgent(nodeId);
}

function runAsk(nodeId: string, ctx: PluginContext) {
  ensureAgentMention(nodeId, ctx.mutations.onTextChange);
  if (!isLunoraSyncEnabled()) {
    toast.message("Inline agent needs upgraded sync", {
      description: "Turn on the beta sync option in Settings, then try again.",
    });
    return;
  }
  openRunPopoverForNode(nodeId, ctx);
}

/** Confirm to fire; while running, hotkey mirrors trailing Stop. */
function onFireHotkey(nodeId: string, ctx: PluginContext) {
  if (getAgentRunForQuestion(nodeId)?.status === "running") {
    void stopAgent(nodeId);
    return;
  }
  openRunPopoverForNode(nodeId, ctx);
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
      onClick: openRunPopover,
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
      description: "Tag @agent and run (needs upgraded sync)",
      icon: SparklesIcon,
      keywords: ["ask", "agent", "ai", "llm"],
      available: () => true,
      run: (id, ctx) => {
        runAsk(id, ctx);
      },
    },
  ],

  keymap: [
    {
      id: "agent-fire",
      hotkey: "Mod+Shift+Enter",
      run: (id, ctx) => {
        onFireHotkey(id, ctx);
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
        if (q && !"agent".startsWith(q)) return [];
        return [
          {
            key: "agent",
            render: () => <span className="text-sm">@agent</span>,
            replacement: "@agent ",
          },
        ];
      },
    },
  ],

  filterOperators: [
    {
      key: "is",
      values: ["ai"],
      description:
        "Part of an AI exchange (@agent mention or agent-origin answer)",
      predicate: (node) => isAiNode(node),
    },
  ],
});
