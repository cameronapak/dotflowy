import { FocusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { getNodeActionBridge } from "../../data/command-bridge";
import {
  featureSavesSettled,
  peekEditorFeatures,
  subscribeEditorFeatures,
} from "../../data/editor-features";
import { getSession as getAccount } from "../../lib/auth-client";
import { featureToggleAction } from "../feature-actions";
import { definePlugin, type GlobalActionSpec } from "../types";
import { endSession, returnToFocus } from "./actions";
import { openFocusPicker } from "./picker";
import {
  configureAccount,
  getSession,
  subscribeSession,
  updateSession,
} from "./store";
import { closeFocusWindow, FocusBand, FocusMarker } from "./ui";

// The registry hides the band and marker while Focus sessions is off, but the
// clock would keep ticking and cueing sounds. Turning it off lets the running
// session go, with no reflection, in every tab that observes the change.
// Ending is irreversible, so it waits for the switch to persist: a rejected
// save rolls the switch back and the session continues. The band, which
// normally names the account, never mounts while Focus is off, so resolve the
// account here; otherwise a session left in this browser would survive and
// come back with the switch.
let endingForOff = false;
async function endForOff() {
  await featureSavesSettled();
  if (peekEditorFeatures().focusSessions) return;
  closeFocusWindow();
  const { data } = await getAccount();
  if (!data || peekEditorFeatures().focusSessions) return;
  configureAccount(data.user.id);
  if (getSession()) updateSession(() => null);
}
subscribeEditorFeatures(() => {
  const prefs = peekEditorFeatures();
  if (!prefs.ready || prefs.focusSessions) {
    endingForOff = false;
    return;
  }
  if (endingForOff) return;
  endingForOff = true;
  // A failure retries on the next preference change, such as a focus refresh.
  void endForOff().catch(() => {
    endingForOff = false;
  });
});

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
    const toggle = featureToggleAction("focusSessions", "Focus sessions");
    if (!peekEditorFeatures().focusSessions) return [toggle];
    const actions: GlobalActionSpec[] = [
      toggle,
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
