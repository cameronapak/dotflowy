/**
 * Add agent chrome (ADR 0059 step 2): Proof-like join modal + header presence chip.
 *
 * Paid gate is UX-only (`subscription.list` → plan ≠ free); MCP tools still
 * enforce `agentAccess` server-side (#170). Free users see upgrade bait — no
 * pretend copy/join loop.
 */

import { useNavigate } from "@tanstack/react-router";
import { BotIcon, CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { buildAgentJoinPrompt } from "../data/agent-join-prompt";
import {
  livePresenceAt,
  refetchAgentPresence,
  useAgentPresenceRows,
} from "../data/agent-presence";
import { type PlanName } from "../data/plans";
import { subscription } from "../lib/auth-client";
import { cn } from "../lib/utils";
import { openAddAgent, setAddAgentOpener } from "./add-agent-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const POLL_MS_WAITING = 3_000;
const POLL_MS_IDLE = 15_000;
const TICK_MS = 5_000;

type PlanState = "loading" | "error" | "ready";

type SubRow = { plan: string; status: string };

function resolvePlan(subs: SubRow[]): PlanName {
  let plan: PlanName = "free";
  for (const s of subs) {
    if (s.status !== "active" && s.status !== "trialing") continue;
    if (s.plan === "founding") return "founding";
    if (s.plan === "unlimited") plan = "unlimited";
  }
  return plan;
}

/** Client plan for Add agent UX. Server still gates MCP `agentAccess`. */
function useClientPlan(): { state: PlanState; plan: PlanName | null } {
  const [state, setState] = useState<PlanState>("loading");
  const [plan, setPlan] = useState<PlanName | null>(null);

  useEffect(() => {
    let cancelled = false;
    subscription.list().then(
      ({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setState("error");
          return;
        }
        setPlan(resolvePlan((data ?? []) as SubRow[]));
        setState("ready");
      },
      () => {
        if (!cancelled) setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { state, plan };
}

function appOrigin(): string {
  return typeof window !== "undefined"
    ? window.location.origin
    : "https://app.dotflowy.com";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied for your agent");
  } catch {
    toast.error("Couldn't copy to clipboard");
    throw new Error("copy failed");
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function usePresencePoll(active: boolean, waiting: boolean) {
  useEffect(() => {
    if (!active) return;
    void refetchAgentPresence();
    const ms = waiting ? POLL_MS_WAITING : POLL_MS_IDLE;
    const id = window.setInterval(() => {
      void refetchAgentPresence();
    }, ms);
    return () => window.clearInterval(id);
  }, [active, waiting]);
}

function JoinPromptPreview({ text }: { text: string }) {
  return (
    <pre
      className={cn(
        "max-h-48 overflow-auto rounded-md border bg-muted/40 p-3",
        "font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground",
      )}
    >
      {text}
    </pre>
  );
}

function AddAgentDialogBody({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { state: planState, plan } = useClientPlan();
  const rows = useAgentPresenceRows();
  const now = useNow(TICK_MS);
  const { live, agent } = livePresenceAt(rows, now);
  const [waiting, setWaiting] = useState(false);
  const [copied, setCopied] = useState(false);

  usePresencePoll(open, waiting && !live);

  useEffect(() => {
    if (!open) {
      setWaiting(false);
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (live && waiting) setWaiting(false);
  }, [live, waiting]);

  const prompt = buildAgentJoinPrompt({ appOrigin: appOrigin() });
  const paid = plan !== null && plan !== "free";
  const free = planState === "ready" && plan === "free";

  const onCopy = useCallback(() => {
    void copyText(prompt)
      .then(() => {
        setCopied(true);
        setWaiting(true);
        void refetchAgentPresence();
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* toast already shown */
      });
  }, [prompt]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Add agent</DialogTitle>
          <DialogDescription>
            Copy one join prompt into Cursor, Claude Code, or another MCP
            client. Your agent connects, announces presence, then waits for asks
            — Dotflowy does not run a model.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 pb-5">
          {planState === "loading" && (
            <p className="text-sm text-muted-foreground">Checking your plan…</p>
          )}

          {planState === "error" && (
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load your plan. Try again from Settings.
            </p>
          )}

          {free && (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">
                Bring-your-own agent requires{" "}
                <span className="font-medium text-foreground">Unlimited</span>{" "}
                (same entitlement as Connect apps / MCP).
              </p>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  void navigate({ to: "/settings" });
                }}
              >
                Upgrade in Settings
              </Button>
            </div>
          )}

          {paid && (
            <>
              {live && agent ? (
                <div
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                  data-agent-joined=""
                >
                  <span
                    className="size-2 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                  <span>
                    <span className="font-medium">{agent.label}</span> is
                    present
                  </span>
                </div>
              ) : null}

              <JoinPromptPreview text={prompt} />

              <Button
                className="w-full"
                onClick={onCopy}
                disabled={waiting && !live}
                data-add-agent-copy=""
              >
                {live ? (
                  <>
                    <CheckIcon />
                    Agent joined — copy again
                  </>
                ) : waiting ? (
                  <>
                    <Loader2Icon className="animate-spin" />
                    Waiting for your agent…
                  </>
                ) : copied ? (
                  <>
                    <CheckIcon />
                    Copied
                  </>
                ) : (
                  <>
                    <CopyIcon />
                    Copy for agent
                  </>
                )}
              </Button>

              {waiting && !live && (
                <p className="text-xs text-muted-foreground">
                  Paste the prompt into your agent and let it connect MCP +
                  announce presence. This updates when a heartbeat arrives.
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mount once in `__root.tsx`. Registers {@link openAddAgent} and hosts the
 * dialog. Presence polling for the header chip also lives here so the chip
 * stays truthful while the modal is closed.
 */
export function AddAgent() {
  const [open, setOpen] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  useEffect(() => {
    setAddAgentOpener(() => setOpen(true));
    return () => setAddAgentOpener(null);
  }, []);

  // Keep presence fresh for the header chip even when the modal is closed.
  usePresencePoll(mounted && !open, false);

  if (!mounted) return null;

  return <AddAgentDialogBody open={open} onOpenChange={setOpen} />;
}

/**
 * Header chip when a live agent session exists (CONTEXT: Presence). Click
 * reopens Add agent. Renders nothing when nobody is present.
 */
export function AgentPresenceChip() {
  const rows = useAgentPresenceRows();
  const now = useNow(TICK_MS);
  const { live, agent } = livePresenceAt(rows, now);
  if (!live || !agent) return null;

  return (
    <Button
      variant="default"
      size="sm"
      data-agent-presence=""
      className="gap-1.5 px-2"
      title={`${agent.label} is present — click for status`}
      aria-label={`${agent.label} is present`}
      onClick={() => openAddAgent()}
    >
      <BotIcon className="size-3.5" />
      <span className="max-w-28 truncate text-xs font-medium">
        {agent.label}
      </span>
    </Button>
  );
}
