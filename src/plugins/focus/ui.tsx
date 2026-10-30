import {
  CheckmarkCircle01Icon,
  Cancel01Icon,
  PauseIcon,
  PlayIcon,
  PictureInPictureOnIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import type { Node } from "../../data/tree";

import { flattenInline } from "../../data/inline-text";
import { redactSpoilers } from "../../data/spoiler";
import { getTreeIndex, useNode, useSyncReady } from "../../data/tree-store";
import { getViewFilter, getViewIsHidden } from "../../data/view-state";
import { useSession as useAccount } from "../../lib/auth-client";
import { cn } from "../../lib/utils";
import { Button, Checkbox, Field, FieldLabel, Input } from "../kit";
import {
  endSession,
  returnToFocus,
  saveReflection,
  setFocusNavigation,
} from "./actions";
import {
  nextRound,
  remaining,
  togglePause,
  type FocusSession,
} from "./session";
import {
  configureAccount,
  readSession,
  updateSession,
  useClock,
  useSession,
} from "./store";

interface DocumentPip {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}
// The API is Chrome desktop-only; feature detection also keeps Safari and
// mobile from showing an unusable Pop out control.
function pipApi(): DocumentPip | null {
  if (!("documentPictureInPicture" in window)) return null;
  // SAFETY: Document Picture-in-Picture is an experimental DOM API not yet in lib.dom.
  return window.documentPictureInPicture as DocumentPip;
}
let pipWindow: Window | null = null;
const pipListeners = new Set<() => void>();
function publishPip() {
  for (const listener of pipListeners) listener();
}
function usePipOpen() {
  return useSyncExternalStore(
    (notify) => {
      pipListeners.add(notify);
      return () => {
        pipListeners.delete(notify);
      };
    },
    () => Boolean(pipWindow && !pipWindow.closed),
    () => false,
  );
}

/** Close the floating window, if any, when Focus sessions is turned off. */
export function closeFocusWindow() {
  if (pipWindow && !pipWindow.closed) pipWindow.close();
}

async function popOut() {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  try {
    const popup = await pipApi()?.requestWindow({ width: 300, height: 180 });
    if (!popup) return;
    pipWindow = popup;
    popup.document.title = "Focus session";
    popup.document.documentElement.className =
      document.documentElement.className;
    for (const style of document.querySelectorAll(
      'style, link[rel="stylesheet"]',
    ))
      popup.document.head.append(style.cloneNode(true));
    // Share loaded faces with the floating document rather than reloading them.
    for (const face of document.fonts) popup.document.fonts.add(face);
    popup.document.body.className = "bg-background text-foreground";
    const root = createRoot(popup.document.body);
    root.render(<FocusSurface card />);
    publishPip();
    // Keep theme changes in step without inventing a second theme provider.
    const observer = new MutationObserver(() => {
      popup.document.documentElement.className =
        document.documentElement.className;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    popup.addEventListener(
      "pagehide",
      () => {
        observer.disconnect();
        root.unmount();
        if (pipWindow === popup) pipWindow = null;
        publishPip();
      },
      { once: true },
    );
  } catch {
    toast.error("Couldn't open picture-in-picture. Try Chrome on a desktop.");
  }
}

function display(text: string | undefined) {
  return flattenInline(redactSpoilers(text || "Untitled"));
}
function timer(ms: number) {
  const seconds = Math.ceil(Math.abs(ms) / 1000);
  return `${ms < 0 ? "+" : ""}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Reflection({
  session,
  card,
}: {
  session: FocusSession;
  card: boolean;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    void saveReflection(session.id, text)
      .catch(() => toast.error("Couldn't save your reflection. Try again."))
      .finally(() => setSaving(false));
  };
  return (
    <form
      className={cn(
        "flex min-w-0 flex-1 flex-wrap items-center gap-2",
        card && "items-end",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) save();
      }}
    >
      <Field
        orientation="horizontal"
        className={cn(
          "min-w-0 flex-1 basis-48 max-sm:basis-full",
          card && "basis-full flex-col items-start",
        )}
      >
        <FieldLabel
          htmlFor={card ? "focus-reflect-pip" : "focus-reflect"}
          className="flex-none! whitespace-nowrap"
        >
          How did it go?
        </FieldLabel>
        <Input
          id={card ? "focus-reflect-pip" : "focus-reflect"}
          className={cn(!card && "flex-1")}
          placeholder="Add a reflection…"
          value={text}
          disabled={saving}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing && event.key === "Enter")
              event.preventDefault();
          }}
        />
      </Field>
      <Button size="sm" type="submit" disabled={saving || !text.trim()}>
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={saving}
        onClick={() =>
          updateSession((current) =>
            current?.id === session.id ? null : current,
          )
        }
      >
        Skip
      </Button>
    </form>
  );
}

/** One state surface, rendered both in the subheader and the real PiP document. */
function FocusSurface({
  card = false,
  rootId = null,
}: {
  card?: boolean;
  rootId?: string | null;
}) {
  const session = useSession();
  const now = useClock(Boolean(session));
  const node = useNode(session?.sourceId ?? "");
  const instance = useNode(session?.nodeId ?? "");
  const parent = useNode(instance?.parentId ?? "");
  const syncReady = useSyncReady();
  const pipOpen = usePipOpen();
  const [away, setAway] = useState(false);

  useEffect(() => {
    // PiP remains mounted when the main tab leaves the editor. Check shared
    // state before announcing a deletion so the two surfaces cannot toast twice.
    if (!session || !syncReady || readSession()?.id !== session.id) return;
    if (!node || !instance) {
      updateSession((current) => (current?.id === session.id ? null : current));
      toast("Focus session ended because the node was deleted.");
    } else if (node.completed && session.phase !== "reflect") endSession(true);
  }, [session, node, instance, syncReady]);

  useEffect(() => {
    if (card || !session) return;
    // Decorations share the editor's visibility: a mounted marker (including
    // the title) is visible. Offscreen windowed rows remain in the current view,
    // so walk ancestors as a fallback rather than treating scroll as wandering.
    const index = getTreeIndex();
    if (
      rootId === session.nodeId ||
      document.querySelector(`li[data-node-id="${CSS.escape(session.nodeId)}"]`)
    ) {
      setAway(false);
      return;
    }
    const filter = getViewFilter();
    let cursor = index.byId.get(session.nodeId);
    let hidden = false;
    let foundRoot = rootId === null;
    let guard = index.byId.size + 1;
    while (cursor && guard-- > 0) {
      if (cursor.id === rootId) {
        foundRoot = true;
        break;
      }
      if (
        getViewIsHidden()(cursor) ||
        (cursor.id !== session.nodeId && cursor.collapsed && !filter)
      ) {
        hidden = true;
        break;
      }
      cursor = cursor.parentId ? index.byId.get(cursor.parentId) : undefined;
    }
    if (
      filter &&
      !filter.visibleIds.has(session.nodeId) &&
      rootId !== session.nodeId
    )
      hidden = true;
    setAway(hidden || !foundRoot);
  }, [session, now, card, rootId]);

  if (!session)
    return card ? (
      <p className="p-4 text-sm text-muted-foreground">No focus session</p>
    ) : null;
  const ms = remaining(session, now);
  const up = session.phase === "focus" && ms <= 0;
  const breaking = session.phase === "break" || session.phase === "ready";
  const progress = Math.max(0, Math.min(1, ms / session.duration));
  const task = node?.isTask && node.kind === null;
  const controls =
    session.phase === "reflect" ? (
      <Reflection key={session.id} session={session} card={card} />
    ) : (
      <>
        {(up || breaking) && (
          <Button size="sm" onClick={() => endSession(true)}>
            {task && (
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                data-icon="inline-start"
              />
            )}
            Done
          </Button>
        )}
        {up && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              updateSession((current) =>
                current
                  ? {
                      ...current,
                      deadline: (current.pausedAt ?? Date.now()) + 300_000,
                      duration: 300_000,
                      notified: false,
                    }
                  : null,
              )
            }
          >
            +5 min
          </Button>
        )}
        {up && (
          <Button size="sm" variant="ghost" onClick={() => endSession(false)}>
            Let go
          </Button>
        )}
        {session.phase === "ready" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              updateSession((current) =>
                current ? nextRound(current, Date.now()) : null,
              )
            }
          >
            Start round {session.round + 1}
          </Button>
        )}
        {!up && session.phase !== "ready" && (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={
                session.pausedAt === null
                  ? "Pause focus session"
                  : "Resume focus session"
              }
              onClick={() =>
                updateSession((current) =>
                  current ? togglePause(current, Date.now()) : null,
                )
              }
            >
              <HugeiconsIcon
                icon={session.pausedAt === null ? PauseIcon : PlayIcon}
              />
            </Button>
            {!card && pipApi() && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="max-sm:hidden"
                aria-label="Pop out focus session"
                title="Pop out (Chrome desktop)"
                aria-pressed={pipOpen}
                onClick={() => {
                  void popOut();
                }}
              >
                <HugeiconsIcon icon={PictureInPictureOnIcon} />
              </Button>
            )}
          </>
        )}
        {!up && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="End focus session"
            onClick={() => endSession(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        )}
      </>
    );

  return (
    <section
      aria-label={card ? "Focus card" : "Focus session"}
      data-focus-phase={session.phase}
      className={cn(
        "relative text-sm",
        card ? "flex min-h-dvh flex-col p-3" : "w-full bg-muted/30",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 gap-2",
          card
            ? "flex-col gap-1.5"
            : "mx-auto max-w-[720px] flex-wrap items-center px-6 py-2 max-sm:px-4",
        )}
      >
        {card && (
          <p className="truncate text-xs text-muted-foreground">
            {breaking ? "Break · " : up ? "Time is up · " : ""}
            {parent ? display(parent.text) : "Home"}
          </p>
        )}
        {session.phase !== "reflect" && (
          <>
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2",
                !card && "max-sm:basis-full",
              )}
            >
              {task && (
                <Checkbox
                  aria-label="Complete focused task"
                  checked={node.completed}
                  onCheckedChange={(checked) => {
                    if (checked) endSession(true);
                  }}
                />
              )}
              {!card && (
                <span className="shrink-0 text-muted-foreground">
                  {breaking
                    ? "Break"
                    : away
                      ? "You set out to"
                      : up
                        ? "Time is up"
                        : "Now"}
                </span>
              )}
              <button
                className={cn(
                  "min-w-0 text-left hover:underline",
                  card ? "line-clamp-2 font-medium" : "truncate",
                )}
                onClick={returnToFocus}
              >
                {display(node?.text)}
              </button>
            </div>
            {session.pomodoro && (
              <span
                aria-label={`Round ${session.round}; ${session.settings.rounds} rounds before a long break`}
                className="flex shrink-0 gap-1"
              >
                {Array.from({ length: session.settings.rounds }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "size-1.5 rounded-full",
                      i < ((session.round - 1) % session.settings.rounds) + 1
                        ? "bg-foreground"
                        : "bg-foreground/20",
                    )}
                  />
                ))}
              </span>
            )}
            <span
              className={cn("shrink-0 tabular-nums", card && "text-xl")}
              aria-label="Focus time remaining"
            >
              {session.phase === "ready" ? "Ready when you are" : timer(ms)}
              {session.pausedAt !== null && (
                <span className="ml-2 text-xs text-muted-foreground">
                  Paused
                </span>
              )}
            </span>
            {card && (
              <div className="h-[3px] w-full bg-muted">
                <div
                  className={cn(
                    "h-full",
                    breaking ? "bg-muted-foreground" : "bg-foreground",
                  )}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
            {!card && away && (
              <Button variant="outline" size="sm" onClick={returnToFocus}>
                Return
              </Button>
            )}
          </>
        )}
        <div
          className={cn(
            "flex items-center gap-1",
            session.phase === "reflect" && "w-full",
            card && "flex-wrap",
          )}
        >
          {card &&
            !up &&
            session.phase !== "ready" &&
            session.phase !== "reflect" && (
              <Button variant="outline" size="sm" onClick={returnToFocus}>
                Back to focus
              </Button>
            )}
          {controls}
        </div>
      </div>
      {!card && session.phase !== "reflect" && (
        <div
          className={cn(
            "absolute bottom-0 left-0 h-0.5",
            breaking ? "bg-muted-foreground" : "bg-foreground",
          )}
          style={{ width: `${progress * 100}%` }}
        />
      )}
    </section>
  );
}

export function FocusBand() {
  const account = useAccount();
  const navigate = useNavigate();
  const session = useSession();
  const node = useNode(session?.sourceId ?? "");
  const pipOpen = usePipOpen();
  const route = useParams({ strict: false }).nodeId;
  useEffect(() => {
    setFocusNavigation(
      (nodeId) => void navigate({ to: "/$nodeId", params: { nodeId } }),
      route ?? null,
    );
  }, [navigate, route]);
  useEffect(() => {
    if (account.data?.user.id) configureAccount(account.data.user.id);
  }, [account.data?.user.id]);
  useEffect(() => {
    if (!session || session.phase !== "focus" || !session.notified || pipOpen)
      return;
    const title = document.title;
    const update = () => {
      document.title = document.hidden
        ? `Time is up - ${display(node?.text)}`
        : title;
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      document.title = title;
    };
  }, [session, node?.text, pipOpen]);
  // Route keys refresh the current-view read immediately rather than waiting
  // for the next clock tick after a navigation.
  return <FocusSurface key={route ?? "home"} rootId={route ?? null} />;
}

export function FocusMarker({ node }: { node: Node }) {
  const session = useSession();
  const active = session?.phase !== "reflect" && session?.sourceId === node.id;
  const now = useClock(active);
  if (!session || !active) return null;
  const fraction = Math.max(
    0,
    Math.min(1, remaining(session, now) / session.duration),
  );
  const angle = fraction * Math.PI * 2;
  const x = 8 + 6 * Math.sin(angle);
  const y = 8 - 6 * Math.cos(angle);
  return (
    <span
      role="img"
      aria-label="Active focus session"
      title={timer(remaining(session, now))}
      className="inline-flex size-4 align-middle text-muted-foreground"
    >
      <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" />
        {fraction >= 0.999 ? (
          <circle cx="8" cy="8" r="5" fill="currentColor" />
        ) : (
          fraction > 0 && (
            <path
              d={`M 8 8 L 8 2 A 6 6 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`}
              fill="currentColor"
            />
          )
        )}
      </svg>
    </span>
  );
}
