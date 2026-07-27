// `@agent` mention chrome (ADR 0059 / ADR 0006 widget): pill + trailing
// play (idle) or Dot Matrix loader + Stop (running). Fire is two-step via
// Seam B on `[data-agent-play]` → Run popover; stop is `[data-agent-stop]`.

import { Play, Square } from "lucide-react";
import { useCallback, useState } from "react";

import { DotmSquare3 } from "@/plugins/kit";

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

  return (
    <span
      ref={setRoot}
      className="inline-flex items-center gap-1 align-baseline"
      data-agent-chrome=""
    >
      <span
        className="agent-chip inline-flex items-center rounded bg-muted px-1 text-[0.85em] text-muted-foreground select-none"
        data-agent=""
        title="@agent"
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
            <DotmSquare3
              size={14}
              dotSize={2}
              speed={1.2}
              className="text-current"
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
