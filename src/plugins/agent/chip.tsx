// `@agent` / `@dot` mention chrome (ADR 0059 / ADR 0006 widget): pill +
// trailing play (idle) or Loader2 + Stop (ask pending/claimed). Play is Seam B
// on `[data-agent-play]`; stop is `[data-agent-stop]`. No hosted AI.

import { BotIcon, Loader2Icon, Play, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { WidgetProps } from "../types";

import { refetchAgentAsks, useActiveAskForNode } from "../../data/agent-asks";
import { resolveNodeId } from "../token-kit";

const BUSY_POLL_MS = 3_000;

export function AgentChip({ source }: WidgetProps) {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const setRoot = useCallback((el: HTMLSpanElement | null) => {
    setNodeId(el ? resolveNodeId(el) : null);
  }, []);
  const active = useActiveAskForNode(nodeId ?? "");
  const busy = active != null;

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      void refetchAgentAsks();
    }, BUSY_POLL_MS);
    return () => window.clearInterval(id);
  }, [busy]);

  return (
    <span
      ref={setRoot}
      className="inline-flex items-center gap-1 align-baseline"
      data-agent-chrome=""
    >
      <span className="inline-flex size-[1.35em] shrink-0 items-center justify-center self-center overflow-hidden rounded-full border border-border bg-background shadow-sm">
        <BotIcon className="size-[0.85em] text-muted-foreground" aria-hidden />
      </span>
      <span
        className="agent-chip inline-flex items-center rounded-full border border-border bg-background px-1.5 text-[0.85em] text-muted-foreground shadow-sm select-none"
        data-agent=""
        title={source}
      >
        {source}
      </span>
      {busy ? (
        <>
          <span
            className="inline-flex shrink-0 items-center justify-center text-muted-foreground"
            aria-hidden="true"
            data-agent-loader=""
          >
            <Loader2Icon className="size-[0.85em] animate-spin" />
          </span>
          <button
            type="button"
            data-agent-stop=""
            title="Cancel ask"
            aria-label="Cancel ask"
            className="inline-flex size-[1.35em] shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
          >
            <Square className="size-[0.65em] fill-current" aria-hidden="true" />
          </button>
        </>
      ) : (
        <button
          type="button"
          data-agent-play=""
          title="Ask agent"
          aria-label="Ask agent"
          className="inline-flex size-[1.35em] shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-accent"
        >
          <Play className="size-[0.7em] fill-current" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
