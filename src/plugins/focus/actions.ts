import { toast } from "sonner";

import { placeCaretAtEnd } from "../../components/caret-place";
import { requestFlashAfterNav, flashRow } from "../../components/flash-node";
import { guardProtected } from "../../components/protection";
import { getNodeActionBridge } from "../../data/command-bridge";
import { capture } from "../../data/history";
import { appendChild, toggleCompleted } from "../../data/mutations";
import { runStructuralTracked } from "../../data/structural";
import { childrenOf, isNodeLocked } from "../../data/tree";
import { getTreeIndex } from "../../data/tree-store";
import { advanceSession, finishSession } from "./session";
import { cue, readSession, updateSession } from "./store";

let navigate: ((nodeId: string) => void) | null = null;
let pageRootId: string | null = null;
/** Retain the app router after the editor unmounts, so PiP can return from Settings. */
export function setFocusNavigation(
  open: (nodeId: string) => void,
  rootId: string | null,
) {
  navigate = open;
  pageRootId = rootId;
}

export function returnToFocus() {
  const session = readSession();
  const bridge = getNodeActionBridge();
  if (!session) return;
  window.focus();
  if (bridge && pageRootId === session.nodeId) {
    const title = document.querySelector<HTMLElement>(".zoomed-title-text");
    if (title) {
      title.focus();
      placeCaretAtEnd(title);
      flashRow(title.closest(".zoomed-title"));
    }
  } else {
    requestFlashAfterNav(session.nodeId);
    if (bridge) bridge.getCtx().nav.open(session.nodeId);
    else navigate?.(session.nodeId);
  }
}

export function endSession(done: boolean) {
  const session = readSession();
  if (!session || session.phase === "reflect") return;
  const index = getTreeIndex();
  if (isNodeLocked(index, session.sourceId)) {
    updateSession(() => null);
    toast(
      done
        ? "Focus session ended. This node is Locked and could not be checked off."
        : "Focus session ended. Locked nodes cannot receive a reflection.",
    );
    return;
  }
  const node = index.byId.get(session.sourceId);
  // Publish the ending before completion so the tree observer cannot end twice.
  updateSession((current) =>
    current
      ? finishSession(advanceSession(current, Date.now()), Date.now())
      : null,
  );
  if (done) {
    if (
      node?.isTask &&
      node.kind === null &&
      !node.completed &&
      !guardProtected(session.sourceId, "complete", null)
    ) {
      capture(index, session.sourceId, null, { label: "completion" });
      toggleCompleted(session.sourceId, true);
    }
    cue("success");
  }
}

export async function saveReflection(sessionId: string, text: string) {
  const save = async () => {
    const session = readSession();
    if (!session || session.id !== sessionId || session.phase !== "reflect")
      return;
    const index = getTreeIndex();
    if (!index.byId.has(session.sourceId)) {
      updateSession(() => null);
      return;
    }
    if (isNodeLocked(index, session.sourceId)) {
      toast("This node is Locked. No reflection was written.");
      updateSession(() => null);
      return;
    }
    const reflection = text.trim().replace(/\s*\n\s*/g, " ");
    if (reflection) {
      const date = new Date(session.startedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const minutes = Math.round(session.focusMs / 6000) / 10;
      const { persisted } = runStructuralTracked(() => {
        capture(index, session.sourceId);
        appendChild(
          session.sourceId,
          childrenOf(index, session.sourceId).at(-1)?.id ?? null,
          `Focus session, ${date}, ${minutes} min: ${reflection}`,
        );
      });
      await persisted;
    }
    updateSession((current) => (current?.id === sessionId ? null : current));
  };
  if (navigator.locks)
    await navigator.locks.request(
      `dotflowy-focus-reflection:${sessionId}`,
      save,
    );
  else await save();
}
