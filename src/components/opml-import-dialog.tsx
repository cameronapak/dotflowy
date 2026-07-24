import { useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { CircleCheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { nodesCollection } from "../data/collection";
import { isLunoraSyncEnabled } from "../data/flags";
import { capture, drop } from "../data/history";
import { getLunoraOutlineContext } from "../data/lunora-sync";
import {
  OPML_APP_MAX_NODES,
  OpmlEmpty,
  OpmlImportTooLarge,
  parseOpml,
  planOpmlImport,
  type OpmlImportResult,
  type OpmlImportReport,
} from "../data/opml-import";
import { makeOutlineNode, type OutlineNode } from "../data/outline-plans";
import { runStructuralSliced } from "../data/structural";
import { childrenOf, makeNode, now } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import { setOpmlImportOpener } from "./opml-import-opener";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * OPML import (ADR 0037, app surface): "Import OPML…" opens the hidden file
 * input below; the chosen file is parsed CLIENT-side and ONE dialog carries the
 * whole flow — summary/confirm with explicit degradation disclosure, modal
 * progress, then success ("Go to imported") or an error that states plainly
 * that nothing was imported. Mounted once in `__root.tsx`; both entry surfaces
 * (More menu + Cmd+K) reach it through `openOpmlImport()`.
 *
 * The commit is the client write path, not a new endpoint: one history
 * `capture` (a single Cmd+Z removes the whole import), then — flag OFF — ONE
 * `runStructuralSliced` transaction (every insert lands as one `POST
 * /api/nodes {ops}` → DO `applyBatch`). Flag ON (ADR 0055): chunked Lunora
 * `importNodes` mutators (clientSeq FIFO, ~500 nodes/watermark). A mid-import
 * failure on the Lunora path can leave earlier chunks durable; the dialog still
 * reports failure and does not claim success. Flag-OFF faults reject the
 * transaction, TanStack rolls back, and nothing was imported.
 *
 * The optimistic inserts are applied in ~500-node SLICES that yield to the
 * event loop between applications (multiple `mutate` calls on the one
 * manually-committed transaction): a 17k-node import is seconds of main-thread
 * work, and a single synchronous burst froze the dialog mid-paint — spinner
 * dead, app "hung". Slicing keeps the progress counter painting while changing
 * nothing on the wire.
 *
 * Everything lands under one fresh top-level container ("Imported from
 * Workflowy — {date}"), ALWAYS appended (re-import = a second container, no
 * dedup) and created `collapsed: true` — the perf guard: `buildVisibleRows`
 * never descends into a collapsed root, so a huge optimistic insert can't
 * thrash the windowed list mid-commit.
 */

type Stage =
  | { kind: "closed" }
  | { kind: "summary"; data: OpmlImportResult; fileName: string }
  | { kind: "importing"; count: number; applied: number }
  | { kind: "success"; containerId: string; count: number }
  | { kind: "error"; title: string; detail: string | null };

/** How many nodes one optimistic slice inserts before yielding for a paint —
 *  sized to keep each slice comfortably under a perceptible pause while
 *  keeping the yield overhead negligible (a 17k import is ~36 slices). */
const IMPORT_SLICE_NODES = 500;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Every disclosure line the summary shows — the core report's tally rendered
 *  verbatim ("N notes became child bullets", each counted degradation, each
 *  tolerated HTML anomaly, each unknown attribute). Empty = full fidelity. */
function disclosureLines(report: OpmlImportReport): string[] {
  const lines: string[] = [];
  if (report.notes > 0) {
    lines.push(
      `${plural(report.notes, "note")} became ${plural(report.noteLines, "child bullet")}`,
    );
  }
  if (report.noteBlanksDropped > 0) {
    lines.push(
      `${plural(report.noteBlanksDropped, "blank note line")} dropped`,
    );
  }
  if (report.textNewlineSplits > 0) {
    lines.push(
      `${plural(report.textNewlineSplits, "multi-line bullet")} split into child bullets`,
    );
  }
  if (report.mirrorsLinked > 0) {
    lines.push(`${plural(report.mirrorsLinked, "mirror")} re-linked`);
  }
  for (const [message, count] of Object.entries(report.degraded)) {
    lines.push(`${count}× ${message}`);
  }
  for (const [message, count] of Object.entries(report.anomalies)) {
    lines.push(`${count}× ${message} (malformed HTML tolerated)`);
  }
  for (const [name, count] of Object.entries(report.unknownAttributes)) {
    lines.push(`${count}× unknown attribute "${name}" ignored`);
  }
  return lines;
}

/** A parse failure's one-line detail. `OpmlParseError.reason` may already end
 *  with the parser's own "(line X, column Y)" (its `message` getter would then
 *  double it), so only append the location when the reason lacks it. */
function parseErrorDetail(error: {
  _tag: string;
  message: string;
  reason?: string;
  line?: number | null;
  column?: number | null;
}): string {
  if (error._tag !== "OpmlParseError" || error.reason === undefined) {
    return error.message;
  }
  if (error.line != null && !error.reason.includes(`line ${error.line}`)) {
    return `${error.reason} (line ${error.line}, column ${error.column})`;
  }
  return error.reason;
}

function containerText(timestamp: number): string {
  const date = new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `Imported from Workflowy — ${date}`;
}

export function OpmlImportDialog() {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setOpmlImportOpener(() => inputRef.current?.click());
    return () => setOpmlImportOpener(null);
  }, []);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires change again.
    e.target.value = "";
    if (!file) return;
    let source: string;
    try {
      source = await file.text();
    } catch {
      setStage({
        kind: "error",
        title: "Couldn't read the file",
        detail: "The file could not be read. Nothing was imported.",
      });
      return;
    }
    // Parse is pure + synchronous (~29ms for a 17k-node export). A malformed or
    // truncated file fails HERE, with the parser's line/column — the clean
    // error at the summary step, never a half-import.
    const parsed = Effect.runSync(
      Effect.match(parseOpml(source), {
        onSuccess: (data) => ({ ok: true as const, data }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    );
    if (!parsed.ok) {
      setStage({
        kind: "error",
        title: "Couldn't read this OPML file",
        detail: `${parseErrorDetail(parsed.error)}. Nothing was imported.`,
      });
      return;
    }
    const { report } = parsed.data;
    if (report.nodesPost === 0) {
      setStage({
        kind: "error",
        title: "Nothing to import",
        detail: "The file contains no outline bullets. Nothing was imported.",
      });
      return;
    }
    // The friendly ceiling (ADR 0037): counted post note-splitting, rejected
    // here in the dialog before any plan or write exists.
    if (report.nodesPost > OPML_APP_MAX_NODES) {
      setStage({
        kind: "error",
        title: "This file is too large to import",
        detail: `It holds ${report.nodesPost.toLocaleString()} bullets after note splitting; the limit is ${OPML_APP_MAX_NODES.toLocaleString()}. Nothing was imported.`,
      });
      return;
    }
    setStage({ kind: "summary", data: parsed.data, fileName: file.name });
  };

  const onConfirm = async () => {
    if (stage.kind !== "summary") return;
    const { forest, report } = stage.data;
    setStage({ kind: "importing", count: report.nodesPost, applied: 0 });
    // Let the modal progress state paint before planning (id minting for every
    // node) occupies the main thread.
    await new Promise((r) => setTimeout(r, 0));

    const index = getTreeIndex();
    const tops = childrenOf(index, null);
    const lastTop = tops.length ? tops[tops.length - 1]!.id : null;
    const timestamp = now();
    const containerId = crypto.randomUUID();
    const plan = planOpmlImport(forest, {
      parentId: containerId,
      firstPrev: null,
      timestamp,
      newId: () => crypto.randomUUID(),
      maxNodes: OPML_APP_MAX_NODES,
    });
    if (plan instanceof OpmlEmpty || plan instanceof OpmlImportTooLarge) {
      setStage({
        kind: "error",
        title: "Nothing was imported",
        detail: plan.message,
      });
      return;
    }

    // ONE undo point BEFORE the batch: a single Cmd+Z removes the whole import.
    capture(index, null);

    if (isLunoraSyncEnabled()) {
      const lunora = getLunoraOutlineContext();
      if (!lunora) {
        drop();
        setStage({
          kind: "error",
          title: "Import failed",
          detail: "Lunora sync is not ready. Try again in a moment.",
        });
        return;
      }
      const outlineNodes: OutlineNode[] = [
        makeOutlineNode({
          id: containerId,
          userId: lunora.userId,
          parentId: null,
          prevSiblingId: lastTop,
          text: containerText(timestamp),
          collapsed: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ];
      for (const op of plan.ops) {
        if (op.op === "delete") continue;
        outlineNodes.push({ ...op.value, userId: lunora.userId });
      }
      try {
        let applied = 0;
        const total = outlineNodes.length;
        for (let i = 0; i < outlineNodes.length; i += IMPORT_SLICE_NODES) {
          const chunk = outlineNodes.slice(i, i + IMPORT_SLICE_NODES);
          const tx = lunora.store.mutators.importNodes({
            userId: lunora.userId,
            nodes: chunk,
          });
          await tx.isPersisted.promise;
          applied += chunk.length;
          setStage({ kind: "importing", count: total, applied });
          await new Promise((r) => setTimeout(r, 0));
        }
        setStage({ kind: "success", containerId, count: plan.count });
      } catch {
        drop();
        setStage({
          kind: "error",
          title: "Import failed",
          detail:
            "The outline could not be fully saved. Earlier chunks may have landed — undo or re-import carefully.",
        });
      }
      return;
    }

    // The plan is insert-only, emitted depth-first pre-order with the sibling
    // chain wired by construction — replayed verbatim into the collection, in
    // yielding slices so the progress counter below actually paints. `applied`
    // is read by the progress callback after each slice lands.
    let applied = 0;
    const slices: Array<() => void> = [
      () => {
        nodesCollection.insert(
          makeNode({
            id: containerId,
            prevSiblingId: lastTop,
            text: containerText(timestamp),
            collapsed: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      },
    ];
    for (let i = 0; i < plan.ops.length; i += IMPORT_SLICE_NODES) {
      const chunk = plan.ops.slice(i, i + IMPORT_SLICE_NODES);
      slices.push(() => {
        for (const op of chunk) {
          if (op.op !== "delete") nodesCollection.insert(op.value);
        }
        applied += chunk.length;
      });
    }
    try {
      await runStructuralSliced(slices, () =>
        setStage({ kind: "importing", count: plan.count, applied }),
      );
      setStage({ kind: "success", containerId, count: plan.count });
    } catch {
      // The transaction rolled back (a failed slice rolls back inside
      // runStructuralSliced; a failed send rolls back in TanStack), so the
      // outline already matches the captured snapshot — drop the redundant
      // undo point.
      drop();
      setStage({
        kind: "error",
        title: "Import failed",
        detail: "The outline could not be saved. Nothing was imported.",
      });
    }
  };

  const open = stage.kind !== "closed";
  const importing = stage.kind === "importing";

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".opml,.xml,text/xml,text/x-opml,application/xml"
        className="hidden"
        data-testid="opml-file-input"
        onChange={onFile}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Editing is blocked while the modal progress is up: the dialog can't
          // be dismissed mid-commit (Escape/backdrop are ignored).
          if (!next && !importing) setStage({ kind: "closed" });
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={!importing}
          data-testid="opml-import-dialog"
        >
          {stage.kind === "summary" && (
            <SummaryStage
              data={stage.data}
              fileName={stage.fileName}
              onCancel={() => setStage({ kind: "closed" })}
              onConfirm={onConfirm}
            />
          )}
          {stage.kind === "importing" && (
            <div
              className="flex flex-col items-center gap-3 py-6"
              data-testid="opml-importing"
            >
              <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
              <DialogTitle>Importing…</DialogTitle>
              <DialogDescription>
                {stage.applied < stage.count
                  ? `Adding bullets… ${stage.applied.toLocaleString()} / ${stage.count.toLocaleString()}`
                  : `Saving ${stage.count.toLocaleString()} bullets as one atomic batch.`}
              </DialogDescription>
            </div>
          )}
          {stage.kind === "success" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CircleCheckIcon className="size-4 text-primary" />
                  Import complete
                </DialogTitle>
                <DialogDescription data-testid="opml-success">
                  Imported {stage.count.toLocaleString()} bullets into a new
                  collapsed container at the bottom of your outline. One undo
                  (Cmd+Z) removes it all.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setStage({ kind: "closed" })}
                >
                  Done
                </Button>
                <Button
                  onClick={() => {
                    const nodeId = stage.containerId;
                    setStage({ kind: "closed" });
                    navigate({ to: "/$nodeId", params: { nodeId } });
                  }}
                >
                  Go to imported
                </Button>
              </DialogFooter>
            </>
          )}
          {stage.kind === "error" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <TriangleAlertIcon className="size-4 text-destructive" />
                  {stage.title}
                </DialogTitle>
                <DialogDescription data-testid="opml-error">
                  {stage.detail ?? "Nothing was imported."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  data-testid="opml-error-close"
                  onClick={() => setStage({ kind: "closed" })}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryStage({
  data,
  fileName,
  onCancel,
  onConfirm,
}: {
  data: OpmlImportResult;
  fileName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { report } = data;
  const lines = disclosureLines(report);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import OPML</DialogTitle>
        <DialogDescription data-testid="opml-summary">
          {fileName}: {report.nodesPost.toLocaleString()} bullets will be added
          under a new collapsed "Imported from Workflowy" container.
        </DialogDescription>
      </DialogHeader>
      {lines.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Translated with {plural(lines.length, "disclosure")} — text is never
            lost, presentation may shift:
          </p>
          <ul
            className="max-h-48 scroll-fade overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground"
            data-testid="opml-disclosures"
          >
            {lines.map((line) => (
              <li key={line} className="py-0.5">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Full fidelity: nothing changes in translation.
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm} data-testid="opml-confirm">
          Import {report.nodesPost.toLocaleString()} bullets
        </Button>
      </DialogFooter>
    </>
  );
}
