import { FocusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { getNodeActionBridge } from "../../data/command-bridge";
import { definePlugin, type GlobalActionSpec } from "../types";
import { endSession, returnToFocus } from "./actions";
import { openFocusPicker } from "./picker";
import { getSession, subscribeSession } from "./store";
import { FocusBand, FocusMarker } from "./ui";

function FocusSessionIcon({ className }: { className?: string }) {
  return <HugeiconsIcon icon={FocusIcon} className={className} />;
}

export default definePlugin({
  id: "focus",
  commands: [
    {
      id: "focus",
      label: "Focus session…",
      description: "Choose time to work on this node",
      icon: FocusSessionIcon,
      keywords: ["focus", "session", "pomodoro", "timer"],
      available: () => true,
      run: (id, ctx) => openFocusPicker(id, ctx),
    },
  ],
  globalActions: () => {
    const actions: GlobalActionSpec[] = [
      {
        id: "page",
        label: "Focus on this page…",
        menuLabel: "Focus on this page…",
        description: "Choose time to work on this page",
        icon: FocusSessionIcon,
        available: (rootId) => rootId !== null,
        run: (id) => {
          const bridge = getNodeActionBridge();
          if (id && bridge) openFocusPicker(id, bridge.getCtx());
        },
      },
    ];
    const session = getSession();
    if (session && session.phase !== "reflect")
      actions.push(
        {
          id: "return",
          label: "Return to focus session",
          description: "Go back to the node you chose",
          icon: FocusSessionIcon,
          run: returnToFocus,
        },
        {
          id: "end",
          label: "End focus session",
          menuLabel: "End focus session",
          description: "Let go and optionally reflect",
          icon: FocusSessionIcon,
          run: () => endSession(false),
        },
      );
    return actions;
  },
  chromeChanged: subscribeSession,
  subheaderSlots: [
    { id: "focus-band", placement: "full-width", render: () => <FocusBand /> },
  ],
  slots: [
    {
      id: "focus-marker",
      position: "row:after-text",
      render: (node) => <FocusMarker node={node} />,
    },
    {
      id: "focus-marker-title",
      position: "title:after-text",
      render: (node) => <FocusMarker node={node} />,
    },
  ],
});
