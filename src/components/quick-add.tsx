// Quick-add: a distraction-free capture surface (ADR 0049). Core chrome mounted
// once in `__root.tsx`, opened by Opt+Cmd+N / a Cmd+K action / the mobile FAB
// (a later session). It captures a REAL node in one gesture and never shows you
// Today unless you choose to look:
//
//  - The node is BORN on the first keystroke in the current destination, edited
//    live-synced. An untouched or fully-cleared capture leaves NOTHING behind
//    (discard-if-empty).
//  - Enter = commit & next (clears the editor, overlay stays open); Esc closes.
//    Each capture is its own sibling appended at the BOTTOM of the destination.
//  - The destination defaults to Today via the `captureDestination` seam (the
//    daily plugin fills it, seed-free -- core never imports daily). A `Today ▾`
//    chip retargets the CURRENT node; the destination resets to Today per node.
//  - A quiet running list of THIS session's captures gives proof-of-capture
//    without peeking at Today; each row relocates inline.
//  - Every commit and live-move is ONE `runStructural` batch (ADR 0009).
//
// The surface is a full mini single-node editor (`MiniNodeEditor`) so #tags,
// [[links, /paragraph, emphasis/highlight/spoiler, folding, and the caret menus
// all work live. It is the THIRD render path for a node (bullet -> zoomed title
// -> mini-editor): it reuses the SAME shared primitives ZoomedTitle uses
// (decorate/readSource/caret math, the reveal watcher, the slash + caret-menu
// engines) rather than reimplementing them, with a curated TEXT-AUTHORING-ONLY
// keymap -- the structural verbs (Move/Mirror/Delete/Send to Today) are filtered
// out of the palette, and no indent/outdent/zoom/cross-bullet nav is wired, so
// the capture can never act in the destination's context.

import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { Cause, Effect } from "effect";
import Fuse, { type IFuseOptions } from "fuse.js";
import { ChevronDownIcon, HomeIcon, PlusIcon, XIcon } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  CaptureDestination,
  CommandSpec,
  PluginContext,
} from "../plugins/types";
import type { NodeCommands } from "./node-commands";

import { capture, drop } from "../data/history";
import { hasLink } from "../data/links";
import {
  appendChild,
  moveNode,
  removeNode,
  setIsTask,
  setKind,
  setText,
  toggleCompleted,
} from "../data/mutations";
import { appRuntime } from "../data/runtime";
import { runStructural } from "../data/structural";
import {
  buildTrail,
  childrenOf,
  createId,
  makeNode,
  type Node,
  type TreeIndex,
} from "../data/tree";
import { getTreeIndex, useNode } from "../data/tree-store";
import {
  keymapSpecs,
  resolveCaptureDestination,
  searchAliases,
} from "../plugins/registry";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  watchCaretReveal,
} from "./inline-code";
import { openInlineTargetAtCaret } from "./link-keymap";
import { useMenus } from "./menu-engine";
import {
  copySourceSelection,
  cutSourceSelection,
  pasteIntoBullet,
} from "./paste";
import { setQuickAddOpener } from "./quick-add-opener";
import { useSlashMenu } from "./slash-menu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

// --- The default destination cache -----------------------------------------
//
// Resolving Today round-trips the daily atomic claim (ADR 0041) the first time.
// Cache the last resolved destination so a second open is instant and a fast
// first keystroke lands in the right place; refreshed on every open.
const FALLBACK_DEST: CaptureDestination = {
  parentId: null,
  label: "Top level",
};
let cachedDest: CaptureDestination = FALLBACK_DEST;

// --- The curated slash palette (ADR 0049) ----------------------------------
//
// Text-authoring only: the structural verbs (core Move/Mirror/Delete, daily's
// Send/Mirror to Today) are filtered out so the capture surface can never
// relocate itself mid-compose. Everything else -- /paragraph, /todo, /bullet,
// the emphasis/highlight/spoiler wraps -- stays.
const STRUCTURAL_COMMAND_IDS = new Set([
  "move",
  "mirror",
  "delete",
  "send-to-today",
  "mirror-to-today",
]);
function quickAddCommandFilter(spec: CommandSpec): boolean {
  return !STRUCTURAL_COMMAND_IDS.has(spec.id);
}

// A stable placeholder node for the interval BEFORE the first keystroke (the
// node is born on first input). Slash/menu `available` checks read it; command
// `run`s never fire against it (picks happen after born, a later render).
const PLACEHOLDER_NODE: Node = makeNode({
  id: "__quick_add_draft__",
  text: "",
});

// --- The mini single-node editor -------------------------------------------

export interface MiniEditorHandle {
  focus(): void;
  clear(): void;
  readText(): string;
}

/** The contentEditable capture surface for ONE node. A curated, text-authoring
 *  fork of `OutlineEditor`'s `ZoomedTitle` (AGENTS.md "a node renders in TWO
 *  paths" -- now three): it calls the SAME shared decorate/caret/slash/menu
 *  primitives, but wires NO structural nav and a filtered `/` palette. `onText`
 *  is born-aware (creates the node on the first non-empty input); `ensureBorn`
 *  materializes the node so a paste (link unfurl) has a real id to write into. */
const MiniNodeEditor = forwardRef<
  MiniEditorHandle,
  {
    node: Node;
    getCtx: () => PluginContext;
    onText: (text: string) => void;
    ensureBorn: () => string;
    onCommit: () => void;
    onEscape: () => void;
  }
>(function MiniNodeEditor(
  { node, getCtx, onText, ensureBorn, onCommit, onEscape },
  handle,
) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const syncedRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const caretWatchRef = useRef<(() => void) | null>(null);

  useImperativeHandle(
    handle,
    () => ({
      focus: () => ref.current?.focus(),
      clear: () => {
        const el = ref.current;
        if (el) el.textContent = "";
        syncedRef.current = "";
      },
      readText: () => (ref.current ? readSource(ref.current) : ""),
    }),
    [],
  );

  // The `/` palette (Seam C), curated to text-authoring commands. Same wiring as
  // ZoomedTitle; the keymap below is gated on `!slash.isOpen`.
  const slash = useSlashMenu({
    node,
    ctx: getCtx,
    getEl: () => ref.current,
    onTextChange: onText,
    commandFilter: quickAddCommandFilter,
  });

  // The caret menus (Seam H): the `#` tag picker, `[[` node-link + date pickers.
  const menus = useMenus({
    node,
    getEl: () => ref.current,
    ctx: getCtx,
    onTextChange: onText,
  });

  // Text-authoring keymap ONLY (ADR 0049): the plugin keymaps (emphasis Mod+B/I/
  // U, highlight, spoiler, todos toggle) all format text or node state -- none is
  // structural nav (indent/move/zoom are core-reserved keys we never wire here).
  // Enter commits & starts the next capture; Escape closes the overlay.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onCommit() },
      { hotkey: "Escape", callback: () => onEscape() },
      ...keymapSpecs.map((k) => ({
        hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
        callback: () => {
          const el = ref.current;
          if (
            k.hotkey === "Mod+Enter" &&
            el &&
            openInlineTargetAtCaret(el, getCtx(), { linkParens: "edit" })
          ) {
            return;
          }
          k.run(node.id, getCtx());
        },
      })),
    ],
    // Suspend while a menu owns the keys, exactly like ZoomedTitle.
    { target: ref, enabled: !slash.isOpen && !menus.isOpen },
  );

  return (
    <div className="quick-add-editor">
      <span
        ref={ref}
        className="node-text"
        contentEditable
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-label="Quick add"
        aria-multiline="true"
        data-placeholder="Capture a thought…"
        onInput={(e) => {
          const el = e.currentTarget;
          const text = readSource(el);
          onText(text);
          slash.handleInput();
          menus.handleInput();
          if (!composingRef.current) {
            decorate(el, text, getCaretOffset(el), true);
            syncedRef.current = text;
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          const el = e.currentTarget;
          const text = readSource(el);
          onText(text);
          decorate(el, text, getCaretOffset(el), true);
          syncedRef.current = text;
        }}
        onPaste={(e) => {
          const el = e.currentTarget;
          // Born the node first so a pasted URL's unfurl (afterPaste) has a real
          // id to write the title back into. `structural=null`: a multi-line
          // paste joins with spaces rather than creating a subtree -- the capture
          // stays a single node (ADR 0049; markdown-tree paste is the outline's).
          const plain = e.clipboardData?.getData("text/plain") ?? "";
          const id = plain.trim() ? ensureBorn() : node.id;
          const next = pasteIntoBullet(e, el, id, getCtx, onText, null);
          if (next !== null) syncedRef.current = next;
        }}
        onCopy={(e) => copySourceSelection(e, e.currentTarget)}
        onCut={(e) => {
          const el = e.currentTarget;
          const next = cutSourceSelection(e, el, onText);
          if (next !== null) syncedRef.current = next;
        }}
        onFocus={(e) => {
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = watchCaretReveal(
            el,
            () => composingRef.current,
          );
          if (!hasLink(readSource(el))) return;
          revealLinkAtCaret(el, (t) => {
            syncedRef.current = t;
          });
        }}
        onBlur={(e) => {
          slash.close();
          menus.close();
          const el = e.currentTarget;
          caretWatchRef.current?.();
          caretWatchRef.current = null;
          const text = readSource(el);
          if (hasLink(text)) {
            decorate(el, text, null, false);
            syncedRef.current = text;
          }
        }}
        onKeyDown={(e) => {
          if (menus.handleKeyDown(e)) return;
          slash.handleKeyDown(e);
        }}
      />
      {slash.menu}
      {menus.menu}
    </div>
  );
});

// --- The compact retarget picker -------------------------------------------
//
// Reuses MoveDialogInner's target-search technique (a Fuse over every node, plus
// plugin search aliases so "today" finds the daily note despite its date text) --
// but INLINE, not a modal-over-modal (ADR 0049). Picking calls `onPick` with the
// chosen destination; "Top level" is the Home option.

const TARGET_FUSE_OPTIONS: IFuseOptions<Node> = {
  keys: ["text", { name: "aliases", getFn: (n) => searchAliases(n) }],
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.3,
  minMatchCharLength: 2,
};
const TARGET_LIMIT = 30;

function CaptureTargetPicker({
  index,
  excludeId,
  onPick,
  onCancel,
}: {
  index: TreeIndex;
  /** The node being retargeted -- excluded from its own destination list. */
  excludeId: string | null;
  onPick: (dest: CaptureDestination) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () =>
      Array.from(index.byId.values()).filter(
        (n) => n.id !== excludeId && n.text.trim() !== "",
      ),
    [index, excludeId],
  );
  const fuse = useMemo(
    () => new Fuse(candidates, TARGET_FUSE_OPTIONS),
    [candidates],
  );
  const q = query.trim();
  const results = q
    ? fuse.search(q, { limit: TARGET_LIMIT }).map((r) => r.item)
    : candidates.slice(0, TARGET_LIMIT);
  const showHome = q === "" || "top level".includes(q.toLowerCase());

  const label = (n: Node) => n.text.trim() || "Untitled";

  return (
    <Command shouldFilter={false} className="rounded-md border">
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Capture into…"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <CommandList className="max-h-56">
        {showHome && (
          <CommandGroup heading="Top level">
            <CommandItem
              value="__home__"
              onSelect={() => onPick({ parentId: null, label: "Top level" })}
            >
              <HomeIcon className="size-4 shrink-0 opacity-70" />
              <span>Top level</span>
            </CommandItem>
          </CommandGroup>
        )}
        {results.length > 0 && (
          <CommandGroup heading="Capture into">
            {results.map((n) => (
              <CommandItem
                key={n.id}
                value={n.id}
                onSelect={() => onPick({ parentId: n.id, label: label(n) })}
              >
                <span className="truncate">{label(n)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

// --- The session-capture list ----------------------------------------------

function SessionCaptureRow({
  id,
  label,
  onRelocate,
}: {
  id: string;
  label: string;
  onRelocate: () => void;
}) {
  const node = useNode(id);
  // A discarded capture (undo, or a later empty-clear) drops out of the list.
  if (!node) return null;
  const text = node.text.trim() || "Untitled";
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        type="button"
        onClick={onRelocate}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
      >
        {label}
      </button>
    </li>
  );
}

// --- The overlay shell + capture engine ------------------------------------

interface Capture {
  id: string;
  label: string;
}

function QuickAddOverlay({ onClose }: { onClose: () => void }) {
  const editorRef = useRef<MiniEditorHandle | null>(null);

  // The current draft: born on first keystroke, null until then. A ref for
  // event-time reads (born decisions run synchronously), a state for rendering
  // the live node into the mini-editor.
  const draftIdRef = useRef<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  // The destination for the CURRENT draft (resets to the default per node) + the
  // default (Today). Refs shadow the state so born/live-move read the live value.
  const [dest, setDest] = useState<CaptureDestination>(cachedDest);
  const destRef = useRef(dest);
  destRef.current = dest;
  const defaultRef = useRef<CaptureDestination>(cachedDest);

  const [captures, setCaptures] = useState<Capture[]>([]);
  // Which surface the target picker is retargeting: the current draft
  // ("current") or a committed session row (its id). Null = picker closed.
  const [picking, setPicking] = useState<"current" | string | null>(null);

  const liveDraft = useNode(draftId ?? "");
  const node = draftId && liveDraft ? liveDraft : PLACEHOLDER_NODE;

  // Resolve the default destination (Today) once per open, and focus the editor.
  useEffect(() => {
    let cancelled = false;
    resolveCaptureDestination()
      .then((d) => {
        if (cancelled) return;
        const resolved = d ?? FALLBACK_DEST;
        cachedDest = resolved;
        defaultRef.current = resolved;
        // Only adopt as the current destination if the user hasn't already
        // retargeted or started a draft this session.
        if (draftIdRef.current === null) setDest(resolved);
      })
      .catch(() => {});
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Materialize the node NOW at the bottom of the destination -- one
  // `runStructural` batch, one undo point (ADR 0009). Used by born-on-first-
  // keystroke and by a paste (which needs a real id before its afterPaste).
  const born = useCallback((text: string) => {
    const parentId = destRef.current.parentId;
    const index = getTreeIndex();
    const kids = childrenOf(index, parentId);
    const after = kids.length ? kids[kids.length - 1]!.id : null;
    const newId = createId();
    runStructural(() => {
      capture(index, parentId);
      appendChild(parentId, after, text, newId);
    });
    draftIdRef.current = newId;
    setDraftId(newId);
    return newId;
  }, []);

  // Born-aware text writer: the first non-empty input CREATES the node; later
  // inputs are direct field PATCHes (never structural -- the keystroke path must
  // not await an echo, ADR 0009).
  const commitText = useCallback(
    (text: string) => {
      const existing = draftIdRef.current;
      if (existing) {
        setText(existing, text);
        return existing;
      }
      if (text.trim() === "") return null;
      return born(text);
    },
    [born],
  );

  const ensureBorn = useCallback(() => draftIdRef.current ?? born(""), [born]);

  // Remove the current draft iff it is empty (never-typed, or cleared back to
  // blank) -- discard-if-empty. Drops the born undo point too (like a no-op
  // move-dialog action) so Cmd+Z isn't left a dead step.
  const discardIfEmpty = useCallback(() => {
    const id = draftIdRef.current;
    if (!id) return;
    const index = getTreeIndex();
    const n = index.byId.get(id);
    if (!n || n.text.trim() === "") {
      runStructural(() => removeNode(index, id));
      drop();
    }
    draftIdRef.current = null;
    setDraftId(null);
  }, []);

  // Reset for the next capture: destination back to the default (Today), editor
  // cleared and refocused.
  const resetDraft = useCallback(() => {
    draftIdRef.current = null;
    setDraftId(null);
    setDest(defaultRef.current);
    editorRef.current?.clear();
    editorRef.current?.focus();
  }, []);

  // Enter = commit & next. A non-empty draft is already live in its destination
  // (born-on-keystroke), so "commit" just files it into the session list and
  // starts a fresh draft. An empty Enter discards and starts fresh.
  const commitAndNext = useCallback(() => {
    const id = draftIdRef.current;
    const text = editorRef.current?.readText() ?? "";
    if (!id || text.trim() === "") {
      discardIfEmpty();
      resetDraft();
      return;
    }
    setCaptures((c) => [...c, { id, label: destRef.current.label }]);
    resetDraft();
  }, [discardIfEmpty, resetDraft]);

  const close = useCallback(() => {
    // A non-empty draft is already committed to its destination; only an empty
    // one is discarded. The session list is ephemeral -- it clears on close.
    discardIfEmpty();
    setCaptures([]);
    onClose();
  }, [discardIfEmpty, onClose]);

  // Live-move a node to a new destination as ONE atomic batch (ADR 0009).
  const relocate = useCallback((id: string, next: CaptureDestination) => {
    const index = getTreeIndex();
    const kids = childrenOf(index, next.parentId);
    const after = kids.length ? kids[kids.length - 1]!.id : null;
    runStructural(() => {
      capture(index, id);
      moveNode(index, id, next.parentId, after);
    });
  }, []);

  const onPickTarget = useCallback(
    (next: CaptureDestination) => {
      const which = picking;
      setPicking(null);
      if (which === "current") {
        setDest(next);
        const id = draftIdRef.current;
        if (id) relocate(id, next);
        editorRef.current?.focus();
      } else if (which) {
        relocate(which, next);
        setCaptures((c) =>
          c.map((row) =>
            row.id === which ? { ...row, label: next.label } : row,
          ),
        );
      }
    },
    [picking, relocate],
  );

  // The PluginContext the slash/menu commands run with. Curated: text/kind/
  // task/complete mutations are real (they act on the single draft node); the
  // structural verbs are no-ops (and filtered out of the palette anyway).
  const commands: NodeCommands = useMemo(() => {
    const noop = () => {};
    return {
      onTextChange: (_id, text) => {
        commitText(text);
      },
      onEnter: noop,
      onIndent: noop,
      onOutdent: noop,
      onMoveUp: noop,
      onMoveDown: noop,
      onDeleteNode: noop,
      onToggleCompleted: (id, completed) => toggleCompleted(id, completed),
      onSetTask: (id, isTask) => setIsTask(id, isTask),
      onSetKind: (id, kind) => setKind(id, kind),
      onRequestMove: noop,
      onRequestMirror: noop,
      onToggleCollapsed: noop,
      onMoveFocus: noop,
      onZoom: noop,
      onBulletPointerDown: noop,
      onBulletClick: noop,
      setPendingFocus: noop,
    };
  }, [commitText]);

  const getCtx = useCallback(
    (): PluginContext => ({
      tree: getTreeIndex(),
      mutations: commands,
      nav: { zoom: () => {} },
      openOverlay: () => {},
      openPanel: () => {},
      run: (effect) => {
        appRuntime.runFork(
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                console.error(
                  "[quick-add] async task failed:",
                  Cause.pretty(cause),
                ),
              ),
            ),
          ),
        );
      },
    }),
    [commands],
  );

  const index = getTreeIndex();
  const crumbs =
    dest.parentId === null
      ? "Top level"
      : buildTrail(index, dest.parentId)
          .map((n) => n.text.trim() || "Untitled")
          .join(" › ");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the panel don't bubble here.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col gap-3 rounded-xl border bg-background p-4 shadow-2xl"
        role="dialog"
        aria-label="Quick add"
        onKeyDown={(e: ReactKeyboardEvent) => {
          // A window-level Escape belongs to the overlay, but let an open menu
          // (slash/#/[[) or the target picker consume its own Escape first.
          if (e.key === "Escape" && !picking && e.target === e.currentTarget) {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlusIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Quick add</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                setPicking(picking === "current" ? null : "current")
              }
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              title={crumbs}
              data-quick-add-dest={dest.label}
            >
              <Badge variant="secondary" className="border-0 px-0 font-normal">
                {dest.label}
              </Badge>
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={close}
            >
              <XIcon />
            </Button>
          </div>
        </div>

        {picking === "current" && (
          <CaptureTargetPicker
            index={index}
            excludeId={draftId}
            onPick={onPickTarget}
            onCancel={() => {
              setPicking(null);
              editorRef.current?.focus();
            }}
          />
        )}

        <div className="rounded-lg border bg-card px-3 py-2 focus-within:ring-2 focus-within:ring-ring/40">
          <MiniNodeEditor
            ref={editorRef}
            node={node}
            getCtx={getCtx}
            onText={commitText}
            ensureBorn={ensureBorn}
            onCommit={commitAndNext}
            onEscape={close}
          />
        </div>

        <p className="px-1 text-xs text-muted-foreground">
          <kbd className="font-sans">Enter</kbd> to save &amp; keep going ·{" "}
          <kbd className="font-sans">Esc</kbd> to close
        </p>

        {captures.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="px-2 text-xs font-medium text-muted-foreground">
              Captured this session
            </p>
            <ul className="max-h-48 overflow-y-auto">
              {captures.map((c) => (
                <SessionCaptureRow
                  key={c.id}
                  id={c.id}
                  label={c.label}
                  onRelocate={() => setPicking(picking === c.id ? null : c.id)}
                />
              ))}
            </ul>
            {picking && picking !== "current" && (
              <CaptureTargetPicker
                index={index}
                excludeId={picking}
                onPick={onPickTarget}
                onCancel={() => setPicking(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The quick-add shell (ADR 0049): registers the opener + the global Opt+Cmd+N
 * hotkey, and mounts the overlay when open. Client-only (the overlay reads the
 * live tree via TanStack DB, which hard-fails the `/` prerender -- ADR 0004), so
 * it renders nothing until mounted, mirroring MoveDialog/NodeSwitcher.
 */
export function QuickAdd() {
  const [open, setOpen] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    setQuickAddOpener(() => setOpen(true));
    return () => setQuickAddOpener(null);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Opt+Cmd+N (Workflowy Quick Add parity). `code === "KeyN"` because Option
      // turns the `n` KEY into a dead-key/composed char on macOS.
      if (e.altKey && (e.metaKey || e.ctrlKey) && e.code === "KeyN") {
        e.preventDefault();
        if (!openRef.current) setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!mounted || !open) return null;
  return <QuickAddOverlay onClose={() => setOpen(false)} />;
}
