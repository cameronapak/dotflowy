import { useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/plugins/kit";

import { useDismissable } from "../../components/use-dismissable";
import { getAgentRunForQuestion } from "../../data/agent-runs";
import { isLunoraSyncEnabled } from "../../data/flags";

/** Anchored Run confirm (ADR 0059 — two-step fire). */
export function AgentRunPopover({
  nodeId,
  x,
  y,
  onClose,
  onRun,
}: {
  nodeId: string;
  x: number;
  y: number;
  onClose: () => void;
  onRun: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismissable(ref, onClose);

  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 96);
  const lunora = isLunoraSyncEnabled();
  const running = getAgentRunForQuestion(nodeId)?.status === "running";

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Run agent"
      className="fixed z-50 w-52 rounded-lg border bg-popover p-3 shadow-md"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <p className="text-sm font-medium">Run @agent?</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {lunora
          ? running
            ? "A run is already in progress."
            : "Answer lands as a child of this bullet."
          : "Needs upgraded sync (Settings → beta)."}
      </p>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!lunora || running}
          onClick={onRun}
        >
          Run
        </Button>
      </div>
    </div>,
    document.body,
  );
}
