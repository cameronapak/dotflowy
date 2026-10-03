import { useNavigate, useRouter } from "@tanstack/react-router";
import { Data, Effect } from "effect";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { waitForPendingWritesE } from "../data/api";
import { getAppliedSeq, resyncNodes, waitForSeqE } from "../data/collection";
import { getNodeActionBridge } from "../data/command-bridge";
import {
  RESTORE_SLICE_OPS,
  getHistoryState,
  subscribeHistory,
  clearHistory,
  setHistoryBusy,
  capture,
  setHistoryLocationReader,
  type HistoryLocation,
  type HistoryLabel,
  redo,
  undo,
  waitForPendingCapturesE,
  type RestorePlan,
} from "../data/history";
import {
  NodesResponseError,
  NodesTransportError,
  NodesTimeoutError,
  runPromise,
} from "../data/nodes-client-effect";
import { getSelectionState, selectSingle } from "../data/selection-state";
import { runStructuralTracked, runStructuralSliced } from "../data/structural";
import { getTreeIndex } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import {
  setRestoreProgress,
  setRestoreProgressOpener,
  type Stage,
} from "./history-restore-opener";
import {
  decorate,
  getSelectionRange,
  setSelectionOffsets,
} from "./inline-code";
import { setPendingCaretSelection } from "./pending-caret";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

export function useHistoryState() {
  return useSyncExternalStore(
    subscribeHistory,
    getHistoryState,
    getHistoryState,
  );
}

export function restoreHistory(kind: "undo" | "redo"): void {
  const bridge = getNodeActionBridge();
  runHistoryRestore(kind, bridge?.findFocusedId() ?? null, (id) =>
    bridge?.focusNode(id),
  );
}

let preparedText: {
  id: string;
  tag: string | null;
  label: HistoryLabel;
  location: HistoryLocation;
} | null = null;
let textRun: {
  el: HTMLElement;
  type: string;
  at: number;
  end: number;
  tag: string;
} | null = null;
let textGroup = 0;
let lastLocation: HistoryLocation | null = null;
class HistoryRestoreFailure extends Data.TaggedError("HistoryRestoreFailure")<{
  cause: unknown;
}> {}
const restoreAttempt = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new HistoryRestoreFailure({ cause }),
  });
let returnToLocation:
  | ((plan: RestorePlan) => Effect.Effect<void, HistoryRestoreFailure>)
  | null = null;
const afterRenderE = Effect.callback<void>((resume) => {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => resume(Effect.void));
  });
  return Effect.sync(() => cancelAnimationFrame(frame));
});

function editorLocation(focusId: string | null): HistoryLocation {
  const el = document.activeElement;
  const active =
    el instanceof HTMLElement && el.matches(".node-text") ? el : null;
  const selection = getSelectionState();
  if (
    !active &&
    !selection &&
    lastLocation &&
    (!focusId || focusId === lastLocation.rowKey)
  )
    return lastLocation;
  return {
    rootId: getViewRootId(),
    rowKey: active?.dataset.historyKey ?? focusId,
    caret: active ? getSelectionRange(active) : null,
    selection: selection
      ? { anchorId: selection.anchorId, focusId: selection.focusId }
      : null,
  };
}

/** Consume pre-input intent, also retained across quick-add's asynchronous birth. */
export function takeTextHistory(id: string) {
  const prepared = preparedText;
  preparedText = null;
  if (prepared?.id === id) return prepared;
  textRun = null;
  return { tag: null, label: "edit" as const, location: editorLocation(id) };
}

/** Shared text capture for row, title, and mini editor. Native intent precedes input. */
export function captureTextHistory(id: string, scope?: string): void {
  const intent = takeTextHistory(id);
  capture(getTreeIndex(), id, intent.tag, {
    label: intent.label,
    location: intent.location,
    scope,
  });
}

function visibleChanges(ids: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    for (const row of document.querySelectorAll<HTMLElement>(
      `[data-node-id="${CSS.escape(id)}"], [data-history-key="${CSS.escape(id)}"]`,
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.height && rect.bottom > 0 && rect.top < innerHeight)
        result.set(id, (result.get(id) ?? "") + row.outerHTML);
    }
  }
  return result;
}

/**
 * The single undo/redo funnel: plan the snapshot restore (`history.ts`), then
 * pick the apply path by diff size. A small diff — the common, keystroke-
 * adjacent case — applies synchronously inside `runStructural`, exactly the
 * pre-plan behavior. A huge one (undoing a 17k-node OPML import or big
 * delete) would lock the main thread for seconds in one burst, so it streams
 * through `runStructuralSliced` behind `HistoryRestoreDialog`'s modal
 * progress — the delete-confirm dialog's "deleting" stage, generalized. Both
 * paths keep the wire guarantees: ONE batch POST → one DO `applyBatch` → one
 * echo-hold.
 *
 * `setPendingFocus` is only honored on the sync path: during a sliced restore
 * the modal owns focus, and by the time the batch commits the tree-change
 * effect window `FocusPass` consumes has passed — a pending focus set then
 * would go stale and steal the caret on some later, unrelated tree change.
 * The big-delete flow drops the caret the same way.
 */
export function runHistoryRestore(
  kind: "undo" | "redo",
  focusId: string | null,
  setPendingFocus: (id: string) => void,
  scope?: string,
): Promise<RestorePlan | null> {
  return runPromise(runHistoryRestoreE(kind, focusId, setPendingFocus, scope));
}

export const runHistoryRestoreE = Effect.fn("History.requestRestore")(
  (
    kind: "undo" | "redo",
    focusId: string | null,
    setPendingFocus: (id: string) => void,
    scope?: string,
  ) =>
    Effect.suspend(() => {
      if (getHistoryState().busy) return Effect.succeed(null);
      textRun = null;
      preparedText = null;
      setHistoryBusy(true);
      return applyHistoryE(kind, focusId, setPendingFocus, scope);
    }),
);

const applyHistoryE = Effect.fn("History.restore")((
  kind: "undo" | "redo",
  focusId: string | null,
  setPendingFocus: (id: string) => void,
  scope?: string,
) => {
  let plan: RestorePlan | null = null;
  let committed = false;
  const label = kind === "undo" ? "Undoing" : "Redoing";
  const show = (applied: number) =>
    plan &&
    setRestoreProgress({
      kind: "restoring",
      label,
      total: plan.opCount,
      applied,
    });
  return Effect.gen(function* () {
    yield* waitForPendingCapturesE;
    yield* waitForSeqE(yield* waitForPendingWritesE);
    const expectedSeq = getAppliedSeq();
    plan = (kind === "undo" ? undo : redo)(getTreeIndex(), focusId, scope);
    if (!plan) return null;
    const before = visibleChanges(plan.changedIds);
    if (plan.opCount < RESTORE_SLICE_OPS) {
      yield* restoreAttempt(
        () =>
          runStructuralTracked(() => {
            if (plan?.focusId) setPendingFocus(plan.focusId);
            for (const slice of plan!.slices) slice();
          }, expectedSeq).persisted,
      );
    } else {
      show(0);
      yield* Effect.yieldNow;
      yield* restoreAttempt(() =>
        runStructuralSliced(
          plan!.slices,
          () => show(plan!.applied()),
          expectedSeq,
        ),
      );
    }
    committed = true;
    setRestoreProgress({ kind: "closed" });
    if (!scope && returnToLocation) yield* returnToLocation(plan);
    yield* afterRenderE;
    const after = visibleChanges(plan.changedIds);
    if (
      !scope &&
      !plan.changedIds.some((id) => before.get(id) !== after.get(id))
    ) {
      const id = plan.changedIds.find((key) => getTreeIndex().byId.has(key));
      toast.success(`${kind === "undo" ? "Undid" : "Redid"} ${plan.label}`, {
        duration: 3000,
        action: id
          ? {
              label: "View node",
              onClick: () => {
                if (returnToLocation)
                  void runPromise(
                    returnToLocation({
                      ...plan!,
                      focusId: id,
                      location: {
                        rootId: id,
                        rowKey: id,
                        caret: null,
                        selection: null,
                      },
                    }),
                  );
              },
            }
          : undefined,
      });
    }
    return plan;
  }).pipe(
    Effect.catchTag("HistoryRestoreFailure", ({ cause: error }) =>
      Effect.sync(() => {
        if (committed) {
          toast.error(
            `${kind === "undo" ? "Undid" : "Redid"} ${plan?.label}, but couldn't return to the editing location.`,
          );
          return plan;
        }
        plan?.revert();
        const unknownOutcome =
          error instanceof NodesTransportError ||
          error instanceof NodesTimeoutError;
        const stale =
          error instanceof NodesResponseError && error.status === 409;
        if (stale || unknownOutcome) {
          clearHistory();
          resyncNodes();
        }
        toast.error(
          unknownOutcome
            ? `Couldn't confirm ${kind}. Refreshing your outline.`
            : stale
              ? `${label} stopped because your outline changed. History cleared.`
              : `${label} failed. Nothing was changed.`,
        );
        return null;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        setRestoreProgress({ kind: "closed" });
        setHistoryBusy(false);
      }),
    ),
  );
});

/**
 * The sliced restore's modal progress — undo has no natural dialog, so this
 * minimal one exists solely to (a) show the counter and (b) block input while
 * the outline streams through intermediate states. Mounted once in
 * `__root.tsx`; not dismissable mid-commit, and it closes itself.
 */
export function HistoryRestoreDialog() {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const navigate = useNavigate();
  const router = useRouter();

  useEffect(() => {
    setHistoryLocationReader(editorLocation);
    const beforeInput = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !el.matches(".node-text")) return;
      if (getHistoryState().busy) {
        event.preventDefault();
        return;
      }
      const range = getSelectionRange(el);
      const type = event instanceof InputEvent ? event.inputType : event.type;
      const now = Date.now();
      const contiguous =
        textRun?.el === el &&
        textRun.type === type &&
        now - textRun.at < 1000 &&
        range?.start === range?.end &&
        range?.start === textRun.end;
      const composition = type.includes("Composition");
      const typing =
        type === "insertText" ||
        type.startsWith("deleteContent") ||
        composition;
      const tag = typing
        ? contiguous ||
          (composition && textRun?.el === el && textRun.type === type)
          ? textRun!.tag
          : `text:${++textGroup}`
        : null;
      const location = editorLocation(el.dataset.historyKey ?? null);
      preparedText = {
        id: el.dataset.historyNodeId ?? "",
        tag,
        label:
          type.includes("Paste") || event.type === "paste" ? "paste" : "typing",
        location,
      };
      textRun = tag ? { el, type, at: now, end: range?.end ?? 0, tag } : null;
    };
    const input = (event: Event) => {
      if (textRun && event.target === textRun.el)
        textRun.end = getSelectionRange(textRun.el)?.end ?? 0;
    };
    const remember = (event: Event) => {
      const el = event.target;
      if (el instanceof HTMLElement && el.matches(".node-text")) {
        lastLocation = {
          rootId: getViewRootId(),
          rowKey: el.dataset.historyKey ?? null,
          caret: getSelectionRange(el),
          selection: null,
        };
      }
    };
    const blockEditing = (event: Event) => {
      if (!getHistoryState().busy) return;
      const el = event.target;
      if (
        (el instanceof Element &&
          el.closest(
            ".node-text, .outline-row, [data-mobile-bar], .quick-add-editor",
          )) ||
        (event.type === "keydown" && getSelectionState())
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    for (const type of ["beforeinput", "paste", "cut"])
      document.addEventListener(type, beforeInput, true);
    for (const type of ["keydown", "pointerdown", "click"])
      document.addEventListener(type, blockEditing, true);
    document.addEventListener("input", input, true);
    document.addEventListener("focusout", remember, true);
    return () => {
      setHistoryLocationReader(null);
      for (const type of ["beforeinput", "paste", "cut"])
        document.removeEventListener(type, beforeInput, true);
      for (const type of ["keydown", "pointerdown", "click"])
        document.removeEventListener(type, blockEditing, true);
      document.removeEventListener("input", input, true);
      document.removeEventListener("focusout", remember, true);
    };
  }, []);

  useEffect(() => {
    returnToLocation = (plan) =>
      Effect.gen(function* () {
        const root = plan.location?.rootId ?? null;
        const rootId = root && getTreeIndex().byId.has(root) ? root : null;
        // The rendered view mirror can lag navigation during a zoom transition.
        if (
          router.state.location.pathname !==
          (rootId ? `/${encodeURIComponent(rootId)}` : "/")
        ) {
          if (rootId)
            yield* restoreAttempt(() =>
              navigate({
                to: "/$nodeId",
                params: { nodeId: rootId },
                search: (prev) => prev,
              }),
            );
          else
            yield* restoreAttempt(() =>
              navigate({ to: "/", search: (prev) => prev }),
            );
        }
        if (!plan.focusId) return;
        const key = plan.focusId;
        if (plan.location?.caret)
          setPendingCaretSelection(key, plan.location.caret);
        getNodeActionBridge()?.focusNode(key);
        yield* afterRenderE;
        const el = document.querySelector<HTMLElement>(
          `[data-history-key="${CSS.escape(key)}"]`,
        );
        if (!el) return;
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
        const node = getTreeIndex().byId.get(el.dataset.historyNodeId ?? key);
        const caret = plan.location?.caret;
        if (node)
          decorate(el, node.text, caret?.start ?? node.text.length, true);
        if (caret) setSelectionOffsets(el, caret.start, caret.end);
        if (plan.location?.selection) {
          el.blur();
          window.getSelection()?.removeAllRanges();
          selectSingle(
            plan.location.selection.anchorId,
            plan.location.selection.focusId,
          );
        }
      });
    return () => {
      returnToLocation = null;
    };
  }, [navigate, router]);

  useEffect(() => {
    setRestoreProgressOpener(setStage);
    return () => {
      setRestoreProgressOpener(null);
    };
  }, []);

  return (
    <Dialog open={stage.kind === "restoring"} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        data-testid="history-restore-dialog"
      >
        {stage.kind === "restoring" && (
          <div
            className="flex flex-col items-center gap-3 py-6"
            data-testid="history-restoring"
          >
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
            <DialogTitle>{stage.label}…</DialogTitle>
            <DialogDescription>
              {stage.applied < stage.total
                ? `Applying changes… ${stage.applied.toLocaleString()} / ${stage.total.toLocaleString()}`
                : `Saving ${stage.total.toLocaleString()} changes as one atomic batch.`}
            </DialogDescription>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
