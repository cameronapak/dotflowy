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
import { TAG_PATTERN } from "../../data/tags";
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
    // The page's root reserves a scrollbar gutter. The card never scrolls, so
    // with classic scrollbars that gutter is an empty strip down the window.
    popup.document.documentElement.style.scrollbarGutter = "auto";
    for (const style of document.querySelectorAll(
      'style, link[rel="stylesheet"]',
    ))
      popup.document.head.append(style.cloneNode(true));
    // Share loaded faces with the floating document rather than reloading them.
    for (const face of document.fonts) popup.document.fonts.add(face);
    // A floating window sits on the desktop, not the page, so the whole window
    // is the primary fill in every state rather than the page surface (ADR 0074).
    popup.document.body.className = "bg-primary text-primary-foreground";
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
const TAG_SPLIT = new RegExp(`(${TAG_PATTERN})`, "u");
// Tags stay in the card but step back, so the words of the task lead.
function quietTags(text: string) {
  return text.split(TAG_SPLIT).map((part, index) =>
    index % 2 ? (
      <span key={index} className="font-normal opacity-60">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
// Sessions run up to 24 hours and overtime is unbounded, so an hour or more
// reads as h:mm:ss rather than "134:34".
function timer(ms: number) {
  const seconds = Math.ceil(Math.abs(ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const clock =
    hours > 0
      ? `${hours}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
      : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${ms < 0 ? "+" : ""}${clock}`;
}

// Controls on the primary fill. A ring tinted like the resting border reads as
// no change on the fill, so focus draws an offset outline in the text color.
const fillFocus =
  "focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-primary-foreground";
const fillGhost = cn(
  fillFocus,
  "text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground dark:hover:bg-primary-foreground/15",
);
const fillOutline = cn(
  fillFocus,
  "border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground dark:border-primary-foreground/40 dark:bg-transparent dark:hover:bg-primary-foreground/15",
);
const fillPrimary = cn(
  fillFocus,
  "bg-primary-foreground text-primary hover:bg-primary-foreground/85",
);

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
          className={
            card
              ? cn(
                  fillFocus,
                  "border-primary-foreground/60 bg-transparent text-primary-foreground placeholder:text-primary-foreground/70 dark:bg-transparent",
                )
              : "flex-1"
          }
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
      <Button
        size="sm"
        type="submit"
        className={card ? fillPrimary : undefined}
        disabled={saving || !text.trim()}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={card ? fillGhost : undefined}
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
      <p className="p-4 text-sm opacity-75">No focus session</p>
    ) : null;
  const ms = remaining(session, now);
  const up = session.phase === "focus" && ms <= 0;
  const breaking = session.phase === "break" || session.phase === "ready";
  // Overtime fills the bar: time is up without adding a hue.
  const progress = up ? 1 : Math.max(0, Math.min(1, ms / session.duration));
  const task = node?.isTask && node.kind === null;
  // The running band and the whole PiP window are a solid primary fill, so they
  // stand out against the page and the desktop in both themes without adding a
  // hue (ADR 0074). Only the in-page reflection field keeps the page surface.
  const fill = card || session.phase !== "reflect";
  const ghost = fill ? fillGhost : undefined;
  const outline = fill ? fillOutline : undefined;
  const primary = fill ? fillPrimary : undefined;
  const rounds = session.pomodoro && (
    <span
      aria-label={`Round ${session.round}; ${session.settings.rounds} ${session.settings.rounds === 1 ? "round" : "rounds"} before a long break`}
      className="flex shrink-0 gap-1"
    >
      {Array.from({ length: session.settings.rounds }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            i < ((session.round - 1) % session.settings.rounds) + 1
              ? "bg-primary-foreground"
              : "bg-primary-foreground/25",
          )}
        />
      ))}
    </span>
  );
  const controls =
    session.phase === "reflect" ? (
      <Reflection key={session.id} session={session} card={card} />
    ) : (
      <>
        {(up || breaking) && (
          <Button
            size="sm"
            className={primary}
            onClick={() => endSession(true)}
          >
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
            className={outline}
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
          <Button
            size="sm"
            variant="ghost"
            className={ghost}
            onClick={() => endSession(false)}
          >
            Let go
          </Button>
        )}
        {session.phase === "ready" && (
          <Button
            size="sm"
            variant="outline"
            className={outline}
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
              className={ghost}
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
                className={cn("max-sm:hidden", ghost)}
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
            className={ghost}
            aria-label="End focus session"
            onClick={() => endSession(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} />
          </Button>
        )}
      </>
    );

  // The floating card leads with what you set out to do: the title is the
  // largest thing in the window, the time is a pill, and progress drains as a
  // wash behind everything (ADR 0074). Reflection keeps the stacked layout below.
  if (card && session.phase !== "reflect") {
    const title = display(node?.text);
    return (
      <section
        aria-label="Focus card"
        data-focus-phase={session.phase}
        className="relative h-dvh overflow-hidden text-sm"
      >
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
            breaking ? "bg-primary-foreground/5" : "bg-primary-foreground/9",
          )}
          style={{ width: `${progress * 100}%` }}
        />
        <div className="relative flex h-full flex-col gap-2 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs opacity-70">
              {breaking
                ? "Break · "
                : up
                  ? "Time is up · "
                  : session.pausedAt !== null
                    ? "Paused · "
                    : ""}
              {parent ? display(parent.text) : "Home"}
            </p>
            {rounds}
            <span
              aria-label="Focus time remaining"
              className={cn(
                "max-w-[60%] shrink-0 truncate rounded-full border border-primary-foreground/30 px-2 py-0.5 text-xs tabular-nums",
                up && "bg-primary-foreground/15 font-medium",
              )}
            >
              {/* The pill is narrow; Start round says the rest. */}
              {session.phase === "ready" ? "Ready" : timer(ms)}
            </span>
          </div>
          {/* The title scales with the window; taller windows show more lines. */}
          <div className="flex min-h-0 flex-1 flex-col justify-center">
            <div className="flex min-w-0 items-start gap-[0.45em] text-[clamp(1.125rem,min(7.5vw,13vh),2.5rem)] leading-[1.15] font-bold tracking-[-0.02em]">
              {task && (
                <Checkbox
                  aria-label="Complete focused task"
                  className="mt-[0.2em] size-[0.9em] min-h-4 min-w-4 rounded-[0.22em] border-primary-foreground/60 dark:bg-transparent"
                  checked={node.completed}
                  onCheckedChange={(checked) => {
                    if (checked) endSession(true);
                  }}
                />
              )}
              <button
                // dir="auto" clamps a right-to-left title at its end.
                dir="auto"
                title={title}
                className={cn(
                  fillFocus,
                  "min-w-0 text-start decoration-[0.06em] underline-offset-[0.15em] hover:underline",
                )}
                onClick={returnToFocus}
              >
                <span className="line-clamp-3 [@media(max-height:150px)]:line-clamp-2 [@media(min-height:230px)]:line-clamp-4 [@media(min-height:320px)]:line-clamp-5">
                  {quietTags(title)}
                </span>
              </button>
            </div>
          </div>
          {/* Below 280px, a break's Back to focus, Done, pause, and end would clip,
              so buttons drop their padding and Done its icon. */}
          <div className="flex min-w-0 items-center justify-end gap-1 [@media(max-width:279px)]:gap-0.5 [@media(max-width:279px)]:[&_[data-icon=inline-start]]:hidden [@media(max-width:279px)]:[&_[data-slot=button]]:px-1.5">
            {!up && session.phase !== "ready" && (
              <Button
                size="sm"
                variant="ghost"
                className={cn(ghost, "mr-auto -ml-2 px-2 opacity-80")}
                onClick={returnToFocus}
              >
                Back to focus
              </Button>
            )}
            {controls}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={card ? "Focus card" : "Focus session"}
      data-focus-phase={session.phase}
      className={cn(
        "relative text-sm",
        card
          ? "flex min-h-dvh flex-col p-3"
          : cn(
              "w-full transition-colors duration-200 motion-reduce:transition-none",
              fill ? "bg-primary text-primary-foreground" : "bg-muted/30",
            ),
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
          <p className="truncate text-xs opacity-75">
            {parent ? display(parent.text) : "Home"}
          </p>
        )}
        {session.phase !== "reflect" && (
          <>
            {/* A floor for the title: crowded controls wrap to a second line
                instead of squeezing what you set out to do away. */}
            <div className="flex min-w-0 flex-1 basis-72 items-center gap-2 max-sm:basis-full">
              {task && (
                <Checkbox
                  aria-label="Complete focused task"
                  className={cn(fill && "border-primary-foreground/60")}
                  checked={node.completed}
                  onCheckedChange={(checked) => {
                    if (checked) endSession(true);
                  }}
                />
              )}
              <span className={cn("shrink-0 font-medium", !up && "opacity-75")}>
                {breaking
                  ? "Break"
                  : away
                    ? "You set out to"
                    : up
                      ? "Time is up"
                      : "Now"}
              </span>
              <button
                // dir="auto" truncates a right-to-left title at its end.
                dir="auto"
                title={display(node?.text)}
                className="min-w-0 truncate text-start font-medium hover:underline"
                onClick={returnToFocus}
              >
                {display(node?.text)}
              </button>
            </div>
            {rounds}
            <span
              className="shrink-0 font-medium tabular-nums"
              aria-label="Focus time remaining"
            >
              {session.phase === "ready" ? "Ready when you are" : timer(ms)}
              {session.pausedAt !== null && (
                <span className="ml-2 text-xs opacity-75">Paused</span>
              )}
            </span>
            {away && (
              <Button
                variant="outline"
                size="sm"
                className={outline}
                onClick={returnToFocus}
              >
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
          {controls}
        </div>
      </div>
      {fill && !card && (
        <>
          <div className="absolute bottom-0 left-0 h-1 w-full bg-primary-foreground/20" />
          <div
            className={cn(
              "absolute bottom-0 left-0 h-1",
              breaking ? "bg-primary-foreground/50" : "bg-primary-foreground",
            )}
            style={{ width: `${progress * 100}%` }}
          />
        </>
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
      className="inline-flex size-4 align-middle text-foreground"
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
