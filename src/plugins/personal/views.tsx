// Reviewed views that render personal-plugin definitions (ADR 0095). Every
// pixel comes from Dotflowy components and theme tokens; a definition only
// chooses among them and supplies text.

import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PersonalPluginBlock } from "../../data/personal-plugins";
import type { Node } from "../../data/tree";
import type { PluginContext } from "../types";

import { trailingTone, type Tone } from "../../data/comark";
import { capture } from "../../data/history";
import { flattenInline } from "../../data/inline-text";
import { moveNode } from "../../data/mutations";
import { redactSpoilers } from "../../data/spoiler";
import { runStructural } from "../../data/structural";
import { getTreeIndex, useTreeIndex } from "../../data/tree-store";
import { PuzzleIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { useScaffoldKey } from "../daily/daily-index";
import { SheetDescription, SheetHeader, SheetTitle, Textarea } from "../kit";
import { useInstalled } from "./store";

export const TONE_CLASS = {
  neutral: "border border-border text-muted-foreground",
  blue: "bg-(--tag-blue) text-(--tag-blue-fg)",
  green: "bg-(--tag-green) text-(--tag-green-fg)",
  yellow: "bg-(--tag-yellow) text-(--tag-yellow-fg)",
  red: "bg-(--tag-red) text-(--tag-red-fg)",
  purple: "bg-(--tag-purple) text-(--tag-purple-fg)",
} satisfies Record<Tone, string>;

const display = (text: string) => flattenInline(redactSpoilers(text));

function Chip({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

function Notepad({
  pluginId,
  block,
}: {
  pluginId: string;
  block: Extract<PersonalPluginBlock, { type: "notepad" }>;
}) {
  const query = `pluginId=${encodeURIComponent(pluginId)}&key=${encodeURIComponent(block.key)}`;
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "saving" | "failed">("saved");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // SAFETY: the Worker answers { text } for a live notepad.
    const read = (r: Response) => r.json() as Promise<{ text: string }>;
    void fetch(`/api/personal-plugins/data?${query}`)
      .then((r) => (r.ok ? read(r) : { text: "" }))
      .then((row) => live && setText(row.text))
      .catch(() => live && setText(""));
    return () => {
      live = false;
    };
  }, [query]);
  const change = (value: string) => {
    setText(value);
    setStatus("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void fetch("/api/personal-plugins/data", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId, key: block.key, text: value }),
      })
        .then((r) => setStatus(r.ok ? "saved" : "failed"))
        .catch(() => setStatus("failed"));
    }, 500);
  };
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        aria-label={block.placeholder ?? "Notes"}
        value={text ?? ""}
        disabled={text === null}
        placeholder={block.placeholder}
        maxLength={20_000}
        onChange={(e) => change(e.target.value)}
        className="min-h-32"
      />
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {text === null
          ? "Loading…"
          : status === "saved"
            ? "Saved with this plugin"
            : status === "saving"
              ? "Saving…"
              : "Couldn't save. Keep this tab open and try again."}
      </span>
    </div>
  );
}

function Blocks({
  blocks,
  pluginId,
  compact,
}: {
  blocks: readonly PersonalPluginBlock[];
  pluginId: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        compact
          ? "scroll-fade-x items-center gap-2 overflow-x-auto"
          : "flex-col gap-3",
      )}
    >
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return compact ? (
              <span
                key={i}
                className="shrink-0 text-xs font-medium text-muted-foreground"
              >
                {block.text}
              </span>
            ) : (
              <h3 key={i} className="text-sm font-semibold">
                {block.text}
              </h3>
            );
          case "text":
            return (
              <p
                key={i}
                className={cn(
                  "text-sm",
                  (block.muted || compact) && "text-muted-foreground",
                  compact && "shrink-0 text-xs whitespace-nowrap",
                )}
              >
                {block.text}
              </p>
            );
          case "chips":
            return (
              <div
                key={i}
                className={cn("flex gap-1.5", !compact && "flex-wrap")}
              >
                {block.items.map((item, j) => (
                  <Chip key={j} {...item} />
                ))}
              </div>
            );
          case "list":
            return compact ? (
              <div key={i} className="flex gap-1.5">
                {block.items.map((item, j) => (
                  <Chip
                    key={j}
                    tone={item.tone}
                    label={
                      item.accessory
                        ? `${item.accessory} ${item.title}`
                        : item.title
                    }
                  />
                ))}
              </div>
            ) : (
              <ul
                key={i}
                className="flex flex-col divide-y divide-border rounded-md border border-border"
              >
                {block.items.map((item, j) => (
                  <li key={j} className="flex items-center gap-3 px-3 py-2">
                    {item.tone && item.tone !== "neutral" && (
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          TONE_CLASS[item.tone],
                        )}
                      />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{item.title}</span>
                      {item.subtitle && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    {item.accessory && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {item.accessory}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            );
          case "notepad":
            // A notepad needs room to type; the compact band leaves it out.
            return compact ? null : (
              <Notepad key={i} pluginId={pluginId} block={block} />
            );
        }
      })}
    </div>
  );
}

export function PersonalSubheader() {
  const all = useInstalled();
  const params = useParams({ strict: false });
  const rootId: string | null = params.nodeId ?? null;
  const dayKey = useScaffoldKey(rootId ?? "");
  const visible = all.filter(
    (item) =>
      item.definition.subheader &&
      (item.definition.subheader.when === "always" || dayKey !== null),
  );
  if (!visible.length) return null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 py-1">
      {visible.map((item) => (
        <div
          key={item.definition.id}
          data-personal-plugin={item.definition.id}
          className="flex min-w-0 items-center gap-2"
          title={`${item.definition.name} · personal plugin`}
        >
          <PuzzleIcon size={14} className="shrink-0 text-muted-foreground" />
          <Blocks
            blocks={item.definition.subheader?.blocks ?? []}
            pluginId={item.definition.id}
            compact
          />
        </div>
      ))}
    </div>
  );
}

export function PersonalPanel({ id }: { id: string }) {
  const item = useInstalled().find((i) => i.definition.id === id);
  const spec = item?.definition.panel;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{spec?.title ?? "Plugin unavailable"}</SheetTitle>
        <SheetDescription>
          {item
            ? `Personal plugin · ${item.definition.name}`
            : "This plugin was turned off or removed."}
        </SheetDescription>
      </SheetHeader>
      {item && spec && (
        <div className="px-4 pb-4" data-personal-panel={id}>
          <Blocks blocks={spec.blocks} pluginId={id} />
        </div>
      )}
    </>
  );
}

export function PersonalChip(props: {
  name: string;
  label: string;
  tone: Tone;
  plugin: string;
}) {
  return (
    <span
      data-personal-component={props.name}
      title={`:${props.name} · personal component from ${props.plugin}`}
      className={cn(
        "mx-0.5 inline-flex items-center rounded-full px-2 align-baseline text-[0.85em] leading-snug",
        TONE_CLASS[props.tone],
      )}
    >
      {props.label}
    </span>
  );
}

export function ProgressView({ node, tone }: { node: Node; tone: Tone }) {
  const index = useTreeIndex();
  let done = 0;
  let total = 0;
  const stack = [
    ...(index.childrenByParent.get(node.mirrorOf ?? node.id) ?? []),
  ];
  for (let seen = 0; stack.length && seen < 1000; seen++) {
    const child = index.byId.get(stack.pop()!);
    if (!child) continue;
    if (child.isTask) {
      total++;
      if (child.completed) done++;
    }
    stack.push(
      ...(index.childrenByParent.get(child.mirrorOf ?? child.id) ?? []),
    );
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div
      data-personal-block="progress"
      className="flex max-w-md items-center gap-3 py-1"
    >
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Tasks done"
      >
        <div
          className="h-full rounded-full motion-safe:transition-[width]"
          style={{
            width: `${pct}%`,
            background: `var(--hue-${tone === "neutral" ? "green" : tone})`,
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {total ? `${done} of ${total} done` : "No tasks yet"}
      </span>
    </div>
  );
}

interface BoardDrag {
  cardId: string;
  x: number;
  y: number;
  moved: boolean;
  cx: number;
  cy: number;
  column: string | null;
  before: string | null;
  touch: boolean;
  pressedAt: number;
}

// Same feel as dragging a bullet: a touch must hold still this long before it
// can drag, so a scroll that starts on a card still scrolls.
const BOARD_TOUCH_HOLD_MS = 350;
const MAX_COLUMNS = 8;
const MAX_CARDS = 20;

/** Move a card under `columnId`, before `beforeId` (or last), with the same
 *  atomic, undoable structural move the outline's own drag uses. */
function moveCard(cardId: string, columnId: string, beforeId: string | null) {
  runStructural(() => {
    const index = getTreeIndex();
    const siblings = (index.childrenByParent.get(columnId) ?? []).filter(
      (id) => id !== cardId,
    );
    const at = beforeId ? siblings.indexOf(beforeId) : siblings.length;
    const after =
      at > 0 ? siblings[at - 1]! : at === 0 ? null : (siblings.at(-1) ?? null);
    capture(index, cardId, null, { label: "move" });
    moveNode(index, cardId, columnId, after);
  });
}

export function BoardView({
  node,
  getCtx,
}: {
  node: Node;
  getCtx: () => PluginContext;
}) {
  const index = useTreeIndex();
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const dragRef = useRef<BoardDrag | null>(null);
  dragRef.current = drag;
  const boardRef = useRef<HTMLDivElement>(null);
  // Native touch panning can only be stopped from a non-passive touchmove,
  // and only once the hold has passed.
  useEffect(() => {
    const onTouch = (e: TouchEvent) => {
      const d = dragRef.current;
      if (!d?.touch) return;
      if (e.touches.length !== 1) return setDrag(null);
      if (performance.now() - d.pressedAt >= BOARD_TOUCH_HOLD_MS) {
        if (e.cancelable) e.preventDefault();
        else setDrag(null);
      }
    };
    document.addEventListener("touchmove", onTouch, { passive: false });
    return () => document.removeEventListener("touchmove", onTouch);
  }, []);
  const columns = (
    index.childrenByParent.get(node.mirrorOf ?? node.id) ?? []
  ).slice(0, MAX_COLUMNS);
  const columnIds = columns.map((id) => index.byId.get(id)?.mirrorOf ?? id);

  const target = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const column =
      el?.closest<HTMLElement>("[data-board-column]")?.dataset.boardColumn ??
      null;
    const card = el?.closest<HTMLElement>("[data-board-card]");
    let before: string | null = null;
    if (card && column) {
      const rect = card.getBoundingClientRect();
      before =
        y < rect.top + rect.height / 2
          ? card.dataset.boardCard!
          : (card.nextElementSibling?.closest<HTMLElement>("[data-board-card]")
              ?.dataset.boardCard ?? null);
    }
    return { column, before };
  };

  /** Keyboard move: Alt+Left/Right to the next column, Alt+Up/Down within
   *  one. Focus follows the card to its new place. */
  const keyMove = (cardId: string, columnId: string, key: string) => {
    const col = columnIds.indexOf(columnId);
    const cards = index.childrenByParent.get(columnId) ?? [];
    const at = cards.indexOf(cardId);
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const to = columnIds[col + (key === "ArrowLeft" ? -1 : 1)];
      if (!to) return false;
      moveCard(cardId, to, null);
    } else {
      const delta = key === "ArrowUp" ? -1 : 1;
      if (at + delta < 0 || at + delta >= cards.length) return false;
      moveCard(
        cardId,
        columnId,
        delta < 0 ? cards[at - 1]! : (cards[at + 2] ?? null),
      );
    }
    requestAnimationFrame(() =>
      boardRef.current
        ?.querySelector<HTMLElement>(`[data-board-card="${cardId}"]`)
        ?.focus(),
    );
    return true;
  };

  return (
    <div
      ref={boardRef}
      data-personal-block="board"
      role="group"
      aria-label={`Board: ${display(node.text) || "Untitled"}. Alt and arrow keys move a card.`}
      className="flex scroll-fade-x gap-2 overflow-x-auto py-1 select-none"
      onPointerMove={(e) => {
        if (!drag) return;
        const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4;
        if (
          far &&
          !drag.moved &&
          drag.touch &&
          performance.now() - drag.pressedAt < BOARD_TOUCH_HOLD_MS
        )
          return setDrag(null);
        if (far && !drag.moved && drag.touch)
          e.currentTarget.setPointerCapture(e.pointerId);
        const moved = drag.moved || far;
        const next = { ...drag, moved, cx: e.clientX, cy: e.clientY };
        if (moved) Object.assign(next, target(e.clientX, e.clientY));
        setDrag(next);
      }}
      onPointerUp={() => {
        if (!drag) return;
        setDrag(null);
        if (!drag.moved) getCtx().nav.open(drag.cardId);
        else if (drag.column && drag.before !== drag.cardId)
          moveCard(drag.cardId, drag.column, drag.before);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {columns.map((columnId, colIndex) => {
        const column = index.byId.get(columnId);
        if (!column) return null;
        const parentId = columnIds[colIndex]!;
        const cards = (index.childrenByParent.get(parentId) ?? []).slice(
          0,
          MAX_CARDS,
        );
        const over = drag?.moved && drag.column === parentId;
        const { label, tone } = trailingTone(column.text);
        const colored = tone && tone !== "neutral";
        const title = display(label) || "Untitled";
        return (
          <div
            key={columnId}
            data-board-column={parentId}
            data-board-tone={tone ?? undefined}
            role="list"
            aria-label={`${title}, ${cards.length} card${cards.length === 1 ? "" : "s"}`}
            className={cn(
              "flex w-48 shrink-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2",
              colored && "border-transparent",
              over && "border-primary bg-muted",
            )}
            style={
              colored && !over
                ? {
                    background: `color-mix(in oklab, var(--hue-${tone}) 9%, var(--background))`,
                  }
                : undefined
            }
          >
            <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
              <span
                className={cn(
                  "truncate",
                  colored && `rounded-sm px-1.5 py-0.5 ${TONE_CLASS[tone]}`,
                )}
              >
                {title}
              </span>
              <span className="tabular-nums" aria-hidden>
                {cards.length}
              </span>
            </div>
            {cards.map((cardId) => {
              const card = index.byId.get(cardId);
              if (!card) return null;
              return (
                <div
                  key={cardId}
                  role="listitem"
                  data-board-card={cardId}
                  tabIndex={0}
                  aria-label={`${display(card.text) || "Untitled"}${card.completed ? ", done" : ""}. Enter opens it.`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const touch = e.pointerType === "touch";
                    if (!touch) e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({
                      touch,
                      pressedAt: performance.now(),
                      cardId,
                      x: e.clientX,
                      y: e.clientY,
                      cx: e.clientX,
                      cy: e.clientY,
                      moved: false,
                      column: null,
                      before: null,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      getCtx().nav.open(cardId);
                    } else if (
                      e.altKey &&
                      e.key.startsWith("Arrow") &&
                      keyMove(cardId, parentId, e.key)
                    )
                      e.preventDefault();
                  }}
                  className={cn(
                    "relative cursor-grab touch-pan-x touch-pan-y rounded-sm border border-border bg-background px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    card.completed && "text-muted-foreground line-through",
                    drag?.moved &&
                      drag.cardId === cardId &&
                      "cursor-grabbing opacity-50",
                    over &&
                      drag?.before === cardId &&
                      "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-primary",
                  )}
                >
                  {display(card.text) || "Untitled"}
                </div>
              );
            })}
            {over && drag?.before === null && (
              <div className="h-0.5 rounded-full bg-primary" />
            )}
          </div>
        );
      })}
      {!columns.length && (
        <span className="text-xs text-muted-foreground">
          Add child bullets to make columns.
        </span>
      )}
      {drag?.moved &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed z-50 w-44 -translate-x-1/2 -translate-y-1/2 rotate-2 rounded-sm border border-border bg-background px-2 py-1.5 text-sm shadow-lg"
            style={{ left: drag.cx, top: drag.cy }}
          >
            {display(index.byId.get(drag.cardId)?.text ?? "")}
          </div>,
          document.body,
        )}
    </div>
  );
}
