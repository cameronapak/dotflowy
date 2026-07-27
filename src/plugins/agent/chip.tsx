// `@agent` / `@dot` mention chrome (ADR 0059 / ADR 0006 widget): Dot avatar +
// pill + trailing play (idle) or BrailleLoader + Stop (running). Fire is
// two-step via Seam B on `[data-agent-play]` → Run popover; stop is
// `[data-agent-stop]`.

import { Play, Square } from "lucide-react";
import { useCallback, useState } from "react";

import { BrailleLoader, DotAvatar } from "@/plugins/kit";

import type { WidgetProps } from "../types";

import { useAgentRunStatus } from "../../data/agent-runs";
import { resolveNodeId } from "../token-kit";

export function AgentChip({ source }: WidgetProps) {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const setRoot = useCallback((el: HTMLSpanElement | null) => {
    setNodeId(el ? resolveNodeId(el) : null);
  }, []);
  const status = useAgentRunStatus(nodeId ?? "");
  const running = status === "running";

  // Border grammar matches play/stop (`rounded-full border border-border
  // bg-background … shadow-sm`) but each piece stays separate — avatar ring,
  // mention pill, then play/stop — never one fused toolbar blob.
  return (
    <span
      ref={setRoot}
      className="inline-flex items-center gap-1 align-baseline"
      data-agent-chrome=""
    >
      <span className="inline-flex size-[1.35em] shrink-0 self-center overflow-hidden rounded-full border border-border bg-background shadow-sm">
        <DotAvatar className="size-full" title="Dot" />
      </span>
      <span
        className="agent-chip inline-flex items-center rounded-full border border-border bg-background px-1.5 text-[0.85em] text-muted-foreground shadow-sm select-none"
        data-agent=""
        title={source}
      >
        {source}
      </span>
      {running ? (
        <>
          <span
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
            aria-hidden="true"
            data-agent-loader=""
          >
            <BrailleLoader
              variant="breathe"
              speed="normal"
              fontSize={12}
              label="Agent running"
              className="leading-none"
            />
          </span>
          <button
            type="button"
            data-agent-stop=""
            title="Stop"
            aria-label="Stop agent"
            className="inline-flex size-[1.35em] shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
          >
            <Square className="size-[0.65em] fill-current" aria-hidden="true" />
          </button>
        </>
      ) : (
        <button
          type="button"
          data-agent-play=""
          title="Run agent"
          aria-label="Run agent"
          className="inline-flex size-[1.35em] shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
        >
          <Play className="size-[0.7em] fill-current" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
