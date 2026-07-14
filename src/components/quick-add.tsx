// Quick-add: a distraction-free capture surface (ADR 0049). Core chrome mounted
// once in `__root.tsx`, opened by the bare "q" hotkey (Todoist parity -- fired
// only when you're not typing) / a Cmd+K action / the mobile FAB. It captures a
// REAL node in one gesture and never shows you Today unless you choose to look:
//
//  - The node is BORN on the first keystroke in the current destination, edited
//    live-synced. An untouched or fully-cleared capture leaves NOTHING behind
//    (discard-if-empty).
//  - Enter = commit & CLOSE (ADR 0049 amendment): files the single node and
//    dismisses the overlay. If you're NOT viewing the destination (the current
//    zoom root differs from where it landed), a sonner toast confirms it with a
//    "Go there" action that zooms to the destination. An empty Enter just closes.
//  - Cmd+Enter = commit & NEXT: files the node, clears the editor, keeps the
//    overlay open, and appends to the session list -- the rapid-fire burst path.
//    (This DROPS the mini-editor's old Mod+Enter bindings -- the inline-link-open
//    special case and todos' toggle-task; todo toggle stays on /todo and Mod+D.)
//    Each capture is its own sibling appended at the BOTTOM of the destination.
//  - The destination defaults to Today via the `captureDestination` seam (the
//    daily plugin fills it, seed-free -- core never imports daily). A `Today ▾`
//    chip retargets the CURRENT node; the destination resets to Today per node.
//  - A quiet running list of THIS session's captures gives proof-of-capture in
//    the Cmd+Enter multi-capture flow (Enter closes before it's useful); each
//    row relocates inline.
//  - Once a capture is BORN, the node's before-text slots (Seam F -- the todos
//    checkbox et al.) render inline in the mini-editor, mirroring ZoomedTitle, so
//    `/todo` shows a real checkbox. Decoration only -- no structural nav leaks.
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
import { useNavigate } from "@tanstack/react-router";
import { Cause, Effect } from "effect";
import Fuse from "fuse.js";
import {
  ChevronDownIcon,
  CornerDownLeftIcon,
  HomeIcon,
  PlusIcon,
  SunIcon,
} from "lucide-react";
import {
  forwardRef,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import type {
  CaptureDestination,
  CommandSpec,
  PluginContext,
  SlotSpec,
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
  childrenOf,
  createId,
  makeNode,
  type Node,
  type TreeIndex,
} from "../data/tree";
import { getTreeIndex, useNode } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import { useCoarsePointer } from "../hooks/use-coarse-pointer";
import { useKeyboardViewport } from "../hooks/use-keyboard-viewport";
import {
  getCaptureDestination,
  keymapSpecs,
  slotsAt,
} from "../plugins/registry";
import {
  decorate,
  getCaretOffset,
  readSource,
  revealLinkAtCaret,
  watchCaretReveal,
} from "./inline-code";
import { useMenus } from "./menu-engine";
import {
  buildTargetCandidates,
  TARGET_SEARCH_OPTIONS,
} from "./node-target-search";
import {
  copySourceSelection,
  cutSourceSelection,
  pasteIntoBullet,
} from "./paste";
import { setQuickAddOpener } from "./quick-add-opener";
import { useSlashMenu } from "./slash-menu";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** A concrete destination a target pick yields: the parent node id (null = top
 *  level) plus its label. The overlay wraps it into a lazy {@link
 *  CaptureDestination} (resolve -> the fixed id) for the current draft. */
interface PickTarget {
  parentId: string | null;
  label: string;
}

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
 *  is born-aware (creates the node on the first non-empty input, possibly async
 *  while the daily claim settles -- the DOM already holds the typed char, so the
 *  keystroke never blocks).
 *
 *  DRIFT OBLIGATION (ADR 0049): this handler block deliberately MIRRORS
 *  `ZoomedTitle`'s contentEditable wiring (onInput/onPaste/onCopy/onCut/onFocus/
 *  onBlur/onKeyDown + the slash/menus engines + the caret-reveal watcher + the
 *  `*:before-text` node slots -- the THIRD render path for a node's decorations,
 *  AGENTS.md "a node renders in TWO paths"). The duplication is accepted rather
 *  than extracting a shared hook (that would touch the outline's hot path for one
 *  consumer). When you change caret/decorate/menu/slot behavior in ZoomedTitle,
 *  mirror it here (and vice versa). Two DELIBERATE divergences from the title:
 *  (1) the keymap is text-authoring-only -- Enter commits & closes, Cmd+Enter
 *  commits & continues, and the title's Mod+Enter (inline-link-open + todos
 *  toggle) is DROPPED here (todo toggle stays on /todo + Mod+D); (2) only the
 *  PLUGIN slots render, and only once BORN -- the core paragraph-mark/protected-
 *  lock/mirror-badge decorations are omitted (a fresh capture is never a
 *  paragraph title, protected, or a mirror source). */
const MiniNodeEditor = forwardRef<
  MiniEditorHandle,
  {
    node: Node;
    getCtx: () => PluginContext;
    onText: (text: string) => void;
    /** Enter: commit the single node & close the overlay (toast if off-page). */
    onCommit: () => void;
    /** Cmd+Enter: commit & keep going -- clear the editor, overlay stays open. */
    onCommitNext: () => void;
    onEscape: () => void;
  }
>(function MiniNodeEditor(
  { node, getCtx, onText, onCommit, onCommitNext, onEscape },
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
  //
  // Enter = commit & CLOSE; Cmd+Enter = commit & keep going (ADR 0049 amendment).
  // Cmd+Enter is claimed OUTRIGHT here, so the mini-editor DROPS the title path's
  // two Mod+Enter behaviors: the inline-link-open special case AND todos'
  // toggle-task keymap contribution (filtered out below). Todo toggle stays
  // reachable via `/todo` and Mod+D -- this suppression is scoped to quick-add;
  // OutlineRow/ZoomedTitle keep their Mod+Enter bindings.
  useHotkeys(
    [
      { hotkey: "Enter", callback: () => onCommit() },
      { hotkey: "Mod+Enter", callback: () => onCommitNext() },
      { hotkey: "Escape", callback: () => onEscape() },
      ...keymapSpecs
        .filter((k) => k.hotkey !== "Mod+Enter")
        .map((k) => ({
          hotkey: k.hotkey as UseHotkeyDefinition["hotkey"],
          callback: () => k.run(node.id, getCtx()),
        })),
    ],
    // Suspend while a menu owns the keys, exactly like ZoomedTitle.
    { target: ref, enabled: !slash.isOpen && !menus.isOpen },
  );

  // The node's before-text slots (Seam F), mirroring ZoomedTitle's
  // `title:before-text` wiring -- but ONLY the plugin slots (todos checkbox et
  // al.) and ONLY once the draft is BORN. Before born the node is the
  // PLACEHOLDER_NODE (a fake id), whose `getCtx().mutations` would target the
  // placeholder; a slot's own onChange must never fire against it. Node-state is
  // queued as an intent until born (runNodeIntent), so `/todo` on an unborn draft
  // sets no checkbox yet -- it appears the instant the node is real (ADR 0049).
  const born = node.id !== PLACEHOLDER_NODE.id;
  const beforeTextSlots: readonly SlotSpec[] = born
    ? slotsAt("title:before-text")
    : [];

  return (
    <div className="quick-add-editor">
      {beforeTextSlots.map((slot) => (
        <Fragment key={slot.id}>{slot.render(node, getCtx)}</Fragment>
      ))}
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
          // `structural=null`: a multi-line paste joins with spaces rather than
          // creating a subtree -- the capture stays a single node (ADR 0049;
          // markdown-tree paste is the outline's). `onText` borns the node from
          // the pasted text; unfurl (afterPaste) writes back only once the node
          // has a real id (a paste into an already-born capture).
          const next = pasteIntoBullet(e, el, node.id, getCtx, onText, null);
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
// Reuses `/move`'s target-search config + candidate builder (node-target-search.ts,
// so the two pickers can't rank the same query differently) -- but INLINE, not a
// modal-over-modal (ADR 0049). Picking calls `onPick` with the chosen
// destination; "Top level" is the Home option.

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
  onPick: (target: PickTarget) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const candidates = useMemo(
    () =>
      buildTargetCandidates(
        index,
        excludeId ? new Set([excludeId]) : new Set(),
      ),
    [index, excludeId],
  );
  const fuse = useMemo(
    () => new Fuse(candidates, TARGET_SEARCH_OPTIONS),
    [candidates],
  );
  const q = query.trim();
  const results = q
    ? fuse.search(q, { limit: TARGET_LIMIT }).map((r) => r.item)
    : candidates.slice(0, TARGET_LIMIT);
  const showHome = q === "" || "top level".includes(q.toLowerCase());

  const label = (n: Node) => n.text.trim() || "Untitled";

  return (
    <Command shouldFilter={false}>
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

/** The destination selector: a trigger button whose press opens the {@link
 *  CaptureTargetPicker} in an origin-aware popover ANCHORED to the button (ADR
 *  0049 refinement -- was an in-place swap that shoved the capture text around).
 *  Shared by the current-draft chip and each session row, so the two rank the
 *  same query identically and neither reflows the overlay when picking. Base UI's
 *  Popover scales from `--transform-origin` and knows it's a child popup of the
 *  Quick-add Dialog, so the dialog's focus trap lets the picker input take focus.
 */
function DestinationButton({
  index,
  excludeId,
  onPick,
  triggerClassName,
  title,
  children,
  ...dataProps
}: {
  index: TreeIndex;
  /** The node being (re)targeted -- excluded from its own destination list. */
  excludeId: string | null;
  onPick: (target: PickTarget) => void;
  triggerClassName?: string;
  title?: string;
  children: ReactNode;
  /** e.g. `data-quick-add-dest` for the e2e chip locator. */
  "data-quick-add-dest"?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={triggerClassName} title={title} {...dataProps}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0"
      >
        <CaptureTargetPicker
          index={index}
          excludeId={excludeId}
          onPick={(target) => {
            setOpen(false);
            onPick(target);
          }}
          onCancel={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

// --- The session-capture list ----------------------------------------------

function SessionCaptureRow({
  id,
  label,
  index,
  onRelocate,
}: {
  id: string;
  label: string;
  index: TreeIndex;
  onRelocate: (target: PickTarget) => void;
}) {
  const node = useNode(id);
  // A discarded capture (undo, or a later empty-clear) drops out of the list.
  if (!node) return null;
  const text = node.text.trim() || "Untitled";
  return (
    <li className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
      <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <DestinationButton
        index={index}
        excludeId={id}
        onPick={onRelocate}
        title={label}
        triggerClassName="max-w-40 shrink-0 truncate rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-transform hover:bg-muted-foreground/10 active:scale-[0.97]"
      >
        {label}
      </DestinationButton>
    </li>
  );
}

// --- The overlay shell + capture engine ------------------------------------

interface Capture {
  id: string;
  label: string;
}

/** A single in-progress capture. Self-contained so committing can hand the old
 *  draft off (its born finishes against its OWN text) and start a fresh one
 *  synchronously (ADR 0049). Every field a born reads lives HERE, not in shared
 *  mutable overlay state, so concurrent drafts and a slow resolve can't corrupt
 *  each other. */
interface DraftState {
  /** The settled node id, or null until born resolves. */
  id: string | null;
  /** The latest typed text (read by an in-flight born at CREATE time, so it
   *  reflects everything typed while the destination claim was resolving). */
  text: string;
  /** The in-flight born, or null. De-dupes concurrent borns; cleared back to
   *  null when a born settles WITHOUT creating (empty text), so a later keystroke
   *  can retry instead of hitting a poisoned dead promise. */
  promise: Promise<string | null> | null;
  /** This draft's destination resolver (get-or-create the parent, seed-free).
   *  Reassigned on retarget so a not-yet-resolved born lands under the new pick. */
  resolveParent: () => Promise<string | null>;
  /** A retarget that landed after the born already resolved its parent (`null` =
   *  none): the born prefers this at CREATE time so it lands under the pick, not
   *  the stale resolved parent. */
  desiredParent: { value: string | null } | null;
  /** Node-state commands (/todo, /paragraph, Mod+D) issued before the node
   *  exists: queued here and applied against the REAL id once it borns, never
   *  against the placeholder id. */
  intents: Array<(id: string) => void>;
}

function makeDraft(resolveParent: () => Promise<string | null>): DraftState {
  return {
    id: null,
    text: "",
    promise: null,
    resolveParent,
    desiredParent: null,
    intents: [],
  };
}

// --- Deferred-resolve test seam (ADR 0049) ---------------------------------
//
// `seedOutline`'s Map mock resolves the daily claim in a microtask, so the
// in-flight-born window (clear/retarget/slash while borning) never actually
// happens under e2e -- the exact blind spot that hid a cluster of async-lifecycle
// bugs. This DEV-only gate lets a spec HOLD the destination resolve open, drive
// the interfering actions, then release -- exercising the real races. No-op (and
// tree-shaken) in production.
let resolveGate: Promise<void> | null = null;
let releaseResolveGate: (() => void) | null = null;

function awaitResolveGate(): Promise<void> {
  return resolveGate ?? Promise.resolve();
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  const w = window as unknown as {
    __quickAddHoldResolve?: () => void;
    __quickAddReleaseResolve?: () => void;
  };
  w.__quickAddHoldResolve = () => {
    if (resolveGate) return;
    resolveGate = new Promise<void>((r) => {
      releaseResolveGate = r;
    });
  };
  w.__quickAddReleaseResolve = () => {
    releaseResolveGate?.();
    resolveGate = null;
    releaseResolveGate = null;
  };
}

function QuickAddOverlay({ onClose }: { onClose: () => void }) {
  const editorRef = useRef<MiniEditorHandle | null>(null);
  // The off-page toast's "Go there" zooms to the destination (ADR 0049
  // amendment). Quick-add is mounted in `__root.tsx`, inside the router, so the
  // TanStack navigate is available here just as it is to move-dialog/daily.
  const navigate = useNavigate();
  // Position signal (ADR 0030): lift the panel above the software keyboard on a
  // coarse pointer; a fine pointer centers it and ignores the offset.
  const coarse = useCoarsePointer();
  const keyboardOffset = useKeyboardViewport();

  // The destination for the CURRENT draft (resets to the default per node). The
  // default is the LAZY provider (label known now, node created only at born) --
  // captured fresh each open. Refs shadow the state so born/live-move read the
  // live value at event time.
  const [dest, setDest] = useState<CaptureDestination>(getCaptureDestination);
  const destRef = useRef(dest);
  destRef.current = dest;
  const defaultRef = useRef<CaptureDestination>(dest);

  // The current draft (ADR 0049). Born LAZILY on the first keystroke: the typed
  // char is already in the DOM (native contentEditable) and the destination
  // resolve (the daily atomic claim) is awaited OFF the keystroke path, so typing
  // never blocks. The draft owns ALL state a born reads (text/target/intents),
  // so committing starts a fresh draft immediately while the previous born
  // finishes against its OWN object.
  const draftRef = useRef<DraftState | null>(null);
  draftRef.current ??= makeDraft(destRef.current.resolve);
  // `draftId` mirrors the CURRENT draft's settled id, for rendering its node.
  const [draftId, setDraftId] = useState<string | null>(null);

  const [captures, setCaptures] = useState<Capture[]>([]);

  const liveDraft = useNode(draftId ?? "");
  const node = draftId && liveDraft ? liveDraft : PLACEHOLDER_NODE;

  // `mountedRef` lets an in-flight born SAVE its capture even if the overlay
  // closed mid-claim (commit-immediately) without a post-unmount setState.
  const mountedRef = useRef(true);
  // Serializes the node-CREATE step across drafts (not the resolves), so rapid
  // Enters preserve chronological order regardless of which resolve settles
  // first (bug 6). Overlay-scoped, reset each open.
  const createChainRef = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    mountedRef.current = true;
    const raf = requestAnimationFrame(() => editorRef.current?.focus());
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Live-move a node under a new parent as ONE atomic batch (ADR 0009). Skips the
  // undo point when nothing actually moved (re-picking the same parent), via the
  // move-dialog drop-on-no-op pattern -- SAFE here because the capture we just
  // pushed is guaranteed the stack top (relocate is atomic, nothing between).
  const relocate = useCallback((id: string, parentId: string | null) => {
    const index = getTreeIndex();
    const kids = childrenOf(index, parentId);
    const after = kids.length ? kids[kids.length - 1]!.id : null;
    const moved = runStructural(() => {
      capture(index, id);
      return moveNode(index, id, parentId, after);
    });
    if (!moved) drop();
  }, []);

  // Kick off a draft's born. Serialized through `createChainRef` so the CREATE
  // steps run in submission order (chronological log). Resolves the draft's
  // destination (get-or-create Today, seed-free), creates the node from the
  // draft's OWN latest text as ONE `runStructural` batch, applies any queued
  // node-state intents, and lands it under the currently-desired target (a
  // retarget mid-flight wins). Idempotent (returns the live promise). If the
  // text is empty at create time (cleared, or an abandoned open), NOTHING is
  // created AND the cached promise is released so a later keystroke can retry.
  const startBorn = useCallback((d: DraftState): Promise<string | null> => {
    if (d.promise) return d.promise;
    const prev = createChainRef.current;
    const p = (async (): Promise<string | null> => {
      await prev; // preserve create order across drafts (bug 6)
      await awaitResolveGate(); // deferred-resolve test seam
      if (d.id) return d.id;
      const resolved = await d.resolveParent();
      if (d.text.trim() === "") return null; // empty -> no node
      // A retarget that landed after we called resolveParent wins at create time.
      const target = d.desiredParent ? d.desiredParent.value : resolved;
      const index = getTreeIndex();
      const kids = childrenOf(index, target);
      const after = kids.length ? kids[kids.length - 1]!.id : null;
      const newId = createId();
      // Apply any queued node-state intents (/todo, /paragraph, Mod+D) INSIDE the
      // same batch as the insert -- so the node is born with its state in ONE
      // atomic op. Applying them AFTER (a separate PATCH) races the insert POST
      // on the wire: the field edit can reach the DO before the node exists there
      // and be lost. Coalescing into one batch removes the race (ADR 0009).
      const intents = d.intents;
      d.intents = [];
      runStructural(() => {
        capture(index, target);
        appendChild(target, after, d.text, newId);
        for (const intent of intents) intent(newId);
      });
      d.id = newId;
      if (mountedRef.current && draftRef.current === d) setDraftId(newId);
      return newId;
    })();
    d.promise = p;
    createChainRef.current = p.then(
      () => {},
      () => {},
    );
    // Release a cached promise that created nothing, so a later keystroke on the
    // same draft can retry instead of hitting a poisoned dead promise (bug 1).
    void p.then((id) => {
      if (id === null && d.promise === p) d.promise = null;
    });
    return p;
  }, []);

  // Born-aware text writer for the CURRENT draft: the first non-empty input kicks
  // off the lazy born; later inputs are direct field PATCHes (never structural --
  // the keystroke path must not await an echo, ADR 0009). Always records the
  // latest text so an in-flight born creates with everything typed so far.
  const commitText = useCallback(
    (text: string) => {
      const d = draftRef.current!;
      d.text = text;
      if (d.id) {
        setText(d.id, text);
        return;
      }
      if (text.trim() === "") return;
      void startBorn(d);
    },
    [startBorn],
  );

  // A node-STATE command (/todo, /paragraph, /bullet, Mod+D/Mod+Enter) targets
  // the draft's REAL id -- never the placeholder. If the node exists, apply now;
  // otherwise QUEUE the intent so it applies when the draft borns (bug 4). This
  // is why the slash/keymap can't throw against "__quick_add_draft__".
  const runNodeIntent = useCallback(
    (apply: (id: string) => void) => {
      const d = draftRef.current!;
      if (d.id) {
        apply(d.id);
        return;
      }
      d.intents.push(apply);
      void startBorn(d);
    },
    [startBorn],
  );

  // Remove a draft's node iff it is empty -- discard-if-empty. Captures + removes
  // as its OWN undo step (never a blind `drop()`, which would pop the wrong entry
  // when a relocate captured after the born -- bug 5). An UNBORN draft needs no
  // cleanup: an in-flight born self-discards on empty text.
  const discardDraftIfEmpty = useCallback((d: DraftState) => {
    if (!d.id) return;
    const index = getTreeIndex();
    const n = index.byId.get(d.id);
    if (!n || n.text.trim() === "") {
      const id = d.id;
      runStructural(() => {
        capture(index, null);
        removeNode(index, id);
      });
    }
    d.id = null;
  }, []);

  // Start a FRESH draft for the next capture: destination back to the DEFAULT
  // (bug 2 -- read defaultRef directly, not destRef, which setDest hasn't flushed
  // yet), editor cleared and refocused. The just-committed draft lives on until
  // its own born settles (referenced by the caller), untouched by this.
  const resetDraft = useCallback(() => {
    draftRef.current = makeDraft(defaultRef.current.resolve);
    setDraftId(null);
    setDest(defaultRef.current);
    editorRef.current?.clear();
    editorRef.current?.focus();
  }, []);

  // Enter = commit & next. Snapshot the current draft, RESET immediately (so a
  // fast follow-up keystroke lands in a new draft), then file the snapshot into
  // the session list once its born settles -- the node is already live in its
  // destination (commit-immediately), so filing is just bookkeeping. An empty
  // Enter discards and starts fresh.
  const commitAndNext = useCallback(() => {
    const d = draftRef.current!;
    const text = editorRef.current?.readText() ?? "";
    d.text = text;
    const label = destRef.current.label;
    resetDraft();
    if (text.trim() === "") {
      discardDraftIfEmpty(d);
      return;
    }
    // `startBorn` only creates a node when the draft's text is non-empty, so a
    // returned id is always a real capture. No tree re-read (it lags the
    // optimistic insert); the session row renders text reactively via useNode.
    const file = (id: string | null) => {
      if (!id || !mountedRef.current) return;
      setCaptures((c) => [...c, { id, label }]);
    };
    if (d.id) file(d.id);
    else void startBorn(d).then(file);
  }, [discardDraftIfEmpty, resetDraft, startBorn]);

  const close = useCallback(() => {
    // A non-empty draft is already committed to its destination; only an empty
    // one is discarded. An in-flight born with real text completes and saves
    // (mountedRef gates the setState, not the create). The session list is
    // ephemeral -- it clears on close.
    const d = draftRef.current!;
    if (!d.id && d.text.trim() !== "") void startBorn(d);
    discardDraftIfEmpty(d);
    setCaptures([]);
    onClose();
  }, [discardDraftIfEmpty, startBorn, onClose]);

  // Enter = commit & CLOSE (ADR 0049 amendment). Files the SINGLE current draft,
  // then dismisses the overlay. When the destination isn't the view you're on
  // (its parent differs from the current zoom root), a toast confirms the landing
  // with a "Go there" that zooms to it -- the toast REPLACES the session list as
  // proof-of-capture for the one-and-done case. An empty Enter just closes.
  //
  // Reuses `close()` for teardown: `close()` itself borns a non-empty unborn
  // draft (idempotent with the `startBorn` below -- both return the SAME cached
  // promise) and discards an empty one, so the only extra work here is snapshotting
  // the label and firing the toast once the id settles. The `.then(notify)` is a
  // NEW async path off the born, so it's exercised via the deferred-resolve seam.
  const commitAndClose = useCallback(() => {
    const d = draftRef.current!;
    const text = editorRef.current?.readText() ?? "";
    d.text = text;
    if (text.trim() !== "") {
      // Snapshot the label NOW so a retarget that settles mid-flight can't change
      // the toast copy from under us (the born still lands under the live target).
      const label = destRef.current.label;
      const notify = (id: string | null) => {
        if (!id) return;
        // The born node's parent IS the destination -- read it back rather than
        // re-resolving, so a mid-flight retarget is reflected. If you're already
        // viewing that parent (its zoom root), the capture is on screen: no toast.
        const parentId = getTreeIndex().byId.get(id)?.parentId ?? null;
        if (parentId === getViewRootId()) return;
        toast.success(`Added to ${label}`, {
          action: {
            label: "Go there",
            onClick: () => {
              if (parentId === null) navigate({ to: "/" });
              else navigate({ to: "/$nodeId", params: { nodeId: parentId } });
            },
          },
        });
      };
      if (d.id) notify(d.id);
      else void startBorn(d).then(notify);
    }
    close();
  }, [close, startBorn, navigate]);

  // Retarget the CURRENT draft (the input's destination popover). Update BOTH the
  // resolver (for a born that hasn't resolved yet) AND `desiredParent` (for one
  // whose resolve already returned the stale parent) -- so wherever the in-flight
  // born is, it lands under the pick (bug 3). A born draft live-moves now. Focus
  // returns to the editor next frame, after Base UI settles the popover close.
  const retargetCurrent = useCallback(
    (target: PickTarget) => {
      setDest({ label: target.label, resolve: async () => target.parentId });
      const d = draftRef.current!;
      d.resolveParent = async () => target.parentId;
      d.desiredParent = { value: target.parentId };
      if (d.id) relocate(d.id, target.parentId);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    [relocate],
  );

  // Relocate a committed session row (its own destination popover). The node is
  // already live in its old destination; this live-moves it and re-labels the row.
  const relocateRow = useCallback(
    (rowId: string, target: PickTarget) => {
      relocate(rowId, target.parentId);
      setCaptures((c) =>
        c.map((row) =>
          row.id === rowId ? { ...row, label: target.label } : row,
        ),
      );
    },
    [relocate],
  );

  // The PluginContext the slash/menu commands run with. Curated: text edits and
  // node-state changes act on the DRAFT's real id (node-state ones queue until it
  // borns -- runNodeIntent, so no command ever hits the placeholder id); the
  // structural verbs are no-ops (and filtered out of the palette anyway).
  const commands: NodeCommands = useMemo(() => {
    const noop = () => {};
    return {
      onTextChange: (_id, text) => commitText(text),
      onEnter: noop,
      onIndent: noop,
      onOutdent: noop,
      onMoveUp: noop,
      onMoveDown: noop,
      onDeleteNode: noop,
      onToggleCompleted: (_id, completed) =>
        runNodeIntent((id) => toggleCompleted(id, completed)),
      onSetTask: (_id, isTask) => runNodeIntent((id) => setIsTask(id, isTask)),
      onSetKind: (_id, kind) => runNodeIntent((id) => setKind(id, kind)),
      onRequestMove: noop,
      onRequestMirror: noop,
      onToggleCollapsed: noop,
      onMoveFocus: noop,
      onZoom: noop,
      onBulletPointerDown: noop,
      onBulletClick: noop,
      setPendingFocus: noop,
    };
  }, [commitText, runNodeIntent]);

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

  // The destination glyph (Today = sun, Top level = home) leads the trailing
  // pill, mirroring the Cmd+K command-center chrome.
  const destIcon =
    dest.label === "Today" ? (
      <SunIcon className="size-3.5 text-muted-foreground" />
    ) : dest.label === "Top level" ? (
      <HomeIcon className="size-3.5 text-muted-foreground" />
    ) : null;

  // The shadcn Dialog owns focus-trap, Escape, backdrop, and a11y (ADR 0049 now
  // adopts the Cmd+K command-center frame). `onOpenChange(false)` routes both the
  // Escape and the backdrop tap through the engine's `close()` so discard-if-empty
  // and the commit-immediately born still run. Positioned per pointer type: a
  // fine pointer centers near the top like the command palette; a coarse pointer
  // rides the bottom, lifted above the software keyboard by the visualViewport
  // gap (ADR 0030), falling back to the safe-area inset when there's no keyboard.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        animate={false}
        aria-label="Quick add"
        className={cn(
          "flex max-h-[85vh] w-[calc(100%-2rem)] max-w-xl flex-col gap-0 overflow-hidden rounded-xl! p-0",
          coarse ? "top-auto bottom-4 translate-y-0" : "top-1/3 translate-y-0",
        )}
        style={
          coarse
            ? {
                transform: `translateY(-${keyboardOffset}px)`,
                marginBottom:
                  keyboardOffset === 0
                    ? "env(safe-area-inset-bottom)"
                    : undefined,
              }
            : undefined
        }
      >
        {/* Escape guard: a caret menu (slash / # / [[) or the target picker owns
            Escape to close ITSELF, but Base UI's Dialog listens for Escape on
            `document` and ignores preventDefault -- so without this it would also
            close the whole overlay. While a menu listbox is open (portaled, so it
            survives to this bubble), stop the native event before it reaches that
            document listener. Result: the ADR-0049 progressive Escape -- the first
            press closes the menu, the next closes the dialog. */}
        <div
          className="contents"
          onKeyDown={(e) => {
            if (
              e.key === "Escape" &&
              document.querySelector('[role="listbox"]')
            )
              e.stopPropagation();
          }}
        >
          <DialogTitle className="sr-only">Quick add</DialogTitle>

          {/* Input row: the command-center InputGroup vibe with the destination
            pill trailing (the Raycast spot). The editor is a contentEditable, so
            the InputGroup look is replicated on a plain container. The pill opens
            the destination picker in an anchored popover -- no in-place swap, so
            the capture text never shifts (ADR 0049 refinement). */}
          <div className="p-3 pb-0">
            <div className="flex min-h-9 items-center gap-2 rounded-lg border border-input/30 bg-input/30 px-3 py-2 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <PlusIcon className="size-4 shrink-0 opacity-60" />
              <div className="min-w-0 flex-1">
                <MiniNodeEditor
                  ref={editorRef}
                  node={node}
                  getCtx={getCtx}
                  onText={commitText}
                  onCommit={commitAndClose}
                  onCommitNext={commitAndNext}
                  onEscape={close}
                />
              </div>
            </div>
            {/* Destination pill on its own right-aligned row below the input, so a
                growing label never squishes the editor's width (ADR 0049 UX fix). */}
            <div className="mt-2.5 flex justify-end pb-3">
              <DestinationButton
                index={index}
                excludeId={draftId}
                onPick={retargetCurrent}
                title={`Capture into ${dest.label}`}
                data-quick-add-dest={dest.label}
                triggerClassName="flex shrink-0 items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs transition-transform hover:bg-muted active:scale-[0.97]"
              >
                {destIcon}
                <span className="max-w-64 truncate font-medium">
                  {dest.label}
                </span>
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </DestinationButton>
            </div>
          </div>

          {captures.length > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Captured this session
              </div>
              <ul className="flex flex-col">
                {captures.map((c) => (
                  <SessionCaptureRow
                    key={c.id}
                    id={c.id}
                    label={c.label}
                    index={index}
                    onRelocate={(target) => relocateRow(c.id, target)}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* The keyboard-shortcut legend is meaningless on a touch keyboard, so
              it's fine-pointer only (ADR 0049 refinement / ADR 0030 discipline). */}
          {!coarse && (
            <div className="flex items-start justify-between border-t px-4 py-2.5">
              <div className="flex flex-col items-center gap-1">
                <Kbd>Enter</Kbd>
                <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                  save &amp; close
                </span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <Kbd>Enter</Kbd>
                </KbdGroup>
                <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                  save &amp; add more
                </span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Kbd>Esc</Kbd>
                <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                  close
                </span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- The mobile FAB --------------------------------------------------------

/** Whether ANY contentEditable currently holds focus -- the "is editing" probe
 *  for the FAB (its complement of the mobile actions bar's focus gate, ADR 0030,
 *  but DOM-based so the __root-mounted FAB needs no focus registry). focusout
 *  fires before the next focusin when hopping spans, so re-check next frame. */
function useContentEditableFocused(): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const update = () => {
      const el = document.activeElement as HTMLElement | null;
      setEditing(!!el?.isContentEditable);
    };
    const onFocusOut = () => requestAnimationFrame(update);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return editing;
}

/**
 * The mobile capture button (ADR 0049 / build order phase 6). There's no hotkey
 * on mobile, and the mobile actions bar only appears WHILE editing, so the FAB
 * is its complement -- shown when NOT editing -- giving thumb-reach capture. Same
 * three-signal discipline as the mobile bar (ADR 0030): presence = coarse
 * pointer, visibility = not-editing (and overlay-closed), position = a fixed
 * bottom-right anchor with the safe-area inset. A frosted circle in the app's
 * grayscale grammar, kept unobtrusive.
 */
function QuickAddFab({ onOpen }: { onOpen: () => void }) {
  const coarse = useCoarsePointer();
  const editing = useContentEditableFocused();
  if (!coarse || editing) return null;
  return (
    <button
      type="button"
      aria-label="Quick add"
      data-quick-add-fab
      onClick={onOpen}
      className={cn(
        "fixed right-4 bottom-4 z-40 flex size-14 items-center justify-center rounded-full",
        "border border-border/60 bg-background/70 text-foreground shadow-lg backdrop-blur-xl",
        "ring-1 ring-black/5 transition-transform duration-100 ease-out active:scale-[0.94] dark:ring-white/10",
      )}
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <PlusIcon className="size-6" />
    </button>
  );
}

/**
 * The quick-add shell (ADR 0049): registers the opener + the global bare-"q"
 * hotkey, mounts the mobile FAB (coarse pointer), and mounts the overlay when
 * open. Client-only (the overlay reads the live tree via TanStack DB, which
 * hard-fails the `/` prerender -- ADR 0004), so it renders nothing until
 * mounted, mirroring MoveDialog/NodeSwitcher.
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
      // Bare "q" opens Quick-add when you're NOT typing (Todoist parity), replacing
      // Opt+Cmd+N -- browsers and macOS swallow that chord (the in-app browser ate
      // it too). The guards make an accidental open near-impossible: no modifier
      // held (so Cmd/Ctrl/Alt shortcuts pass through), the focus isn't in any text
      // field or contentEditable (so typing "q" in a bullet is untouched), and no
      // dialog is already open (Cmd+K, a confirm dialog, or Quick-add itself).
      if (e.key !== "q" && e.key !== "Q") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (openRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.isContentEditable) return;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!mounted) return null;
  return (
    <>
      {!open && <QuickAddFab onOpen={() => setOpen(true)} />}
      {open && <QuickAddOverlay onClose={() => setOpen(false)} />}
    </>
  );
}
