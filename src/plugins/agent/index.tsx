// Inline `@agent` plugin (ADR 0059). Seams A (token), B (chip fire/stop),
// C (`/ask`), D (`Mod+Shift+Enter`), H (`@` picker), K (`is:ai`).
// Execution is Lunora-native; classic accounts see the chip but cannot fire.

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
import {
  definePlugin,
  type El,
  type InteractionEvent,
  type MenuTrigger,
  type PluginContext,
} from "../types";
import { AgentRunPopover } from "./run-popover";

function agentChipEl(tok: string): El {
  return {
    tag: "span",
    attrs: {
      class:
        "agent-chip inline-flex items-center gap-0.5 rounded px-1 text-[0.85em] bg-muted text-muted-foreground align-baseline select-none cursor-pointer hover:bg-accent hover:text-accent-foreground",
      "data-agent": "true",
      // Opaque atom (same contract as folded links): caret jumps the chip;
      // readSource round-trips the literal `@agent`.
      "data-src": tok,
      "data-src-len": tok.length,
      contenteditable: "false",
      title: "Run agent",
      role: "button",
    },
    // Play glyph = click-to-run signifier (ADR 0059 chip is the fire control).
    children: [
      {
        tag: "span",
        attrs: {
          class: "text-[0.75em] leading-none opacity-80",
          "aria-hidden": "true",
        },
        children: ["▶"],
      },
      tok,
    ],
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

function openRunPopover(
  el: HTMLElement,
  ctx: PluginContext,
  e: InteractionEvent,
) {
  const row = el.closest("[data-node-id]") as HTMLElement | null;
  const nodeId = row?.dataset.nodeId;
  if (!nodeId) return;
  e.preventDefault();
  e.stopPropagation();

  const run = getAgentRunForQuestion(nodeId);
  if (run?.status === "running") {
    void stopAgent(nodeId);
    return;
  }

  ctx.openOverlay(
    <AgentRunPopover
      nodeId={nodeId}
      x={e.clientX}
      y={e.clientY}
      onClose={() => ctx.openOverlay(null)}
      onRun={() => {
        ctx.openOverlay(null);
        void fireAgent(nodeId);
      }}
    />,
  );
}

async function runAsk(nodeId: string, ctx: PluginContext) {
  ensureAgentMention(nodeId, ctx.mutations.onTextChange);
  if (!isLunoraSyncEnabled()) {
    toast.message("Inline agent needs upgraded sync", {
      description: "Turn on the beta sync option in Settings, then try again.",
    });
    return;
  }
  await fireAgent(nodeId);
}

export default definePlugin({
  id: "agent",

  tokens: [
    {
      id: "agent-mention",
      pattern: AGENT_MENTION,
      // After node-links (5) / daily date (6), before code (10).
      precedence: 7,
      render: (tok) => agentChipEl(tok),
    },
  ],

  interactions: [
    {
      selector: "[data-agent]",
      blockCaretOnMouseDown: true,
      onClick: openRunPopover,
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
        void runAsk(id, ctx);
      },
    },
  ],

  keymap: [
    {
      id: "agent-fire",
      hotkey: "Mod+Shift+Enter",
      run: (id) => {
        void fireAgent(id);
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
