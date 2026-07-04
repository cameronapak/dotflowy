import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

// A self-contained toy outline. NOT the real editor — no sync, no collection,
// no Durable Object. Just enough of Dotflowy's core moves (type, Enter, Tab to
// indent, click a bullet to zoom, collapse) to let a visitor feel it in three
// seconds. This is the hero's whole job: show, don't tell.

type Row = { id: string; text: string; depth: number; collapsed: boolean };

const SEED: Omit<Row, "id">[] = [
  { text: "Plan the week", depth: 0, collapsed: false },
  { text: "Ship dotflowy.com", depth: 1, collapsed: false },
  { text: "Record a 60-second demo", depth: 1, collapsed: false },
  { text: "Reading", depth: 0, collapsed: false },
  { text: "Deep Work by Cal Newport", depth: 1, collapsed: false },
  { text: "Groceries", depth: 0, collapsed: false },
  { text: "Coffee beans", depth: 1, collapsed: false },
];

/** Index just past the last descendant of row `i` (its subtree is [i, end)). */
function subtreeEnd(rows: Row[], i: number): number {
  let j = i + 1;
  while (j < rows.length && rows[j]!.depth > rows[i]!.depth) j++;
  return j;
}

type ViewItem = { row: Row; depth: number; hasChildren: boolean };

/** Slice to the zoomed subtree (if any), then drop rows hidden under a
 * collapsed ancestor. Returns the visible rows with display depths. */
function computeView(
  rows: Row[],
  zoomId: string | null,
): { title: Row | null; items: ViewItem[] } {
  let base = rows;
  let offset = 0;
  let title: Row | null = null;

  if (zoomId) {
    const i = rows.findIndex((r) => r.id === zoomId);
    if (i >= 0) {
      title = rows[i]!;
      base = rows.slice(i + 1, subtreeEnd(rows, i));
      offset = title.depth + 1;
    }
  }

  const items: ViewItem[] = [];
  let hideDeeperThan = Infinity;
  for (let k = 0; k < base.length; k++) {
    const r = base[k]!;
    const depth = r.depth - offset;
    if (depth > hideDeeperThan) continue;
    hideDeeperThan = Infinity;
    const hasChildren = k + 1 < base.length && base[k + 1]!.depth > r.depth;
    items.push({ row: r, depth, hasChildren });
    if (r.collapsed && hasChildren) hideDeeperThan = depth;
  }
  return { title, items };
}

export function HeroOutlineDemo() {
  const idCounter = useRef(SEED.length);
  const [rows, setRows] = useState<Row[]>(() =>
    SEED.map((r, i) => ({ ...r, id: `n${i}` })),
  );
  const [zoomId, setZoomId] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<{ id: string; caret: number } | null>(null);

  // Claim focus after a structural change (new row, indent, delete).
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const el = inputs.current.get(p.id);
    if (el) {
      el.focus();
      const pos = Math.max(0, Math.min(p.caret, el.value.length));
      el.setSelectionRange(pos, pos);
    }
  });

  const newId = () => `n${idCounter.current++}`;

  function setText(id: string, text: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, text } : r)));
  }

  function toggleCollapsed(id: string) {
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, collapsed: !r.collapsed } : r)),
    );
  }

  function reindent(id: string, delta: 1 | -1, caret: number) {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      if (i < 0) return rs;
      const cur = rs[i]!;
      let newDepth: number;
      if (delta > 0) {
        if (i === 0) return rs;
        const prev = rs[i - 1]!;
        newDepth = Math.min(cur.depth + 1, prev.depth + 1);
        if (newDepth === cur.depth) return rs;
      } else {
        if (cur.depth === 0) return rs;
        newDepth = cur.depth - 1;
      }
      const d = newDepth - cur.depth;
      const end = subtreeEnd(rs, i);
      pendingFocus.current = { id, caret };
      return rs.map((r, idx) =>
        idx >= i && idx < end ? { ...r, depth: r.depth + d } : r,
      );
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>, id: string) {
    const el = e.currentTarget;
    const caret = el.selectionStart ?? el.value.length;

    if (e.key === "Enter") {
      e.preventDefault();
      setRows((rs) => {
        const i = rs.findIndex((r) => r.id === id);
        if (i < 0) return rs;
        const cur = rs[i]!;
        const left = cur.text.slice(0, caret);
        const right = cur.text.slice(caret);
        const nid = newId();
        const next = rs.slice();
        next[i] = { ...cur, text: left };
        next.splice(subtreeEnd(rs, i), 0, {
          id: nid,
          text: right,
          depth: cur.depth,
          collapsed: false,
        });
        pendingFocus.current = { id: nid, caret: 0 };
        return next;
      });
      return;
    }

    if (e.key === "Tab") {
      if (e.shiftKey) {
        // Outdent — but let Shift+Tab at the root bubble out, so keyboard
        // users can always escape the widget.
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0 && rows[i]!.depth > 0) {
          e.preventDefault();
          reindent(id, -1, caret);
        }
      } else {
        e.preventDefault();
        reindent(id, 1, caret);
      }
      return;
    }

    if (e.key === "Backspace" && caret === 0 && el.selectionEnd === 0) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return;
      const isLeaf = subtreeEnd(rows, i) === i + 1;
      if (rows.length > 1 && rows[i]!.text === "" && isLeaf) {
        e.preventDefault();
        setRows((rs) => {
          const j = rs.findIndex((r) => r.id === id);
          if (j < 0 || rs.length <= 1) return rs;
          const next = rs.slice();
          next.splice(j, 1);
          const focus = next[Math.max(0, j - 1)];
          if (focus) pendingFocus.current = { id: focus.id, caret: focus.text.length };
          return next;
        });
      }
    }
  }

  const { title, items } = computeView(rows, zoomId);

  return (
    <div className="w-full">
      <div className="overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 shadow-[0_12px_40px_-12px_oklch(0.2_0_0/0.18)]">
        {/* Faux window chrome */}
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <div className="flex items-center gap-2 font-mono text-[13px] font-medium">
            <span className="size-2.5 rounded-full bg-foreground/70" />
            dotflowy
          </div>
          <span className="hidden items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
            <span className="text-[13px]">⌘</span>K
          </span>
        </div>

        {/* Editor body */}
        <div className="px-3 py-4 sm:px-5">
          {title && (
            <div className="mb-3">
              <button
                type="button"
                onClick={() => setZoomId(null)}
                className="mb-2 inline-flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
              >
                <span className="size-1.5 rounded-full bg-muted-foreground/60" />
                Home
                <ChevronRight className="size-3" />
                <span className="text-foreground/70 normal-case">zoomed</span>
              </button>
              <div className="text-xl font-semibold tracking-tight">
                {title.text || "Untitled"}
              </div>
            </div>
          )}

          <ul className="space-y-0.5">
            {items.map(({ row, depth, hasChildren }) => (
              <li
                key={row.id}
                className="group/row flex items-center"
                style={{ paddingInlineStart: depth * 22 }}
              >
                {/* Collapse chevron gutter */}
                <span className="flex w-5 shrink-0 justify-center">
                  {hasChildren ? (
                    <button
                      type="button"
                      aria-label={row.collapsed ? "Expand" : "Collapse"}
                      onClick={() => toggleCollapsed(row.id)}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/row:opacity-100"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform",
                          !row.collapsed && "rotate-90",
                        )}
                      />
                    </button>
                  ) : null}
                </span>

                {/* Bullet dot — click zooms in (Dotflowy's signature move) */}
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setZoomId(row.id)}
                  className="flex size-5 shrink-0 items-center justify-center"
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full bg-foreground/70 transition-all hover:scale-150 hover:bg-foreground",
                      row.collapsed &&
                        "ring-4 ring-muted-foreground/20 hover:ring-muted-foreground/30",
                    )}
                  />
                </button>

                <input
                  ref={(el) => {
                    if (el) inputs.current.set(row.id, el);
                    else inputs.current.delete(row.id);
                  }}
                  aria-label="Outline item"
                  value={row.text}
                  spellCheck={false}
                  onChange={(e) => setText(row.id, e.target.value)}
                  onKeyDown={(e) => onKeyDown(e, row.id)}
                  className="w-full border-0 bg-transparent py-1 text-[15px] leading-snug outline-none placeholder:text-muted-foreground/50"
                  placeholder="Type here…"
                />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Invitation to play */}
      <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center font-mono text-[11px] text-muted-foreground sm:justify-start">
        <span>It's live —</span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd> new
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Tab</Kbd> indent
        </span>
        <span className="inline-flex items-center gap-1">
          click a <span className="text-foreground/80">•</span> to zoom
        </span>
      </p>
    </div>
  );
}
