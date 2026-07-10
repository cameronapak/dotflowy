import { useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { nodesCollection } from "../data/collection";
import { appendChild } from "../data/mutations";
import { runStructural } from "../data/structural";
import { subscribeTree } from "../data/tree-store";
import {
  buildTreeIndex,
  childrenOf,
  trueSourceOf,
} from "../data/tree";
import { localDateKey } from "../plugins/daily/daily-index";
import { getOrCreateDay } from "../plugins/daily";

/**
 * Quick-capture deeplink: `/add?text=…&parentId?=`
 *
 * Creates a bullet immediately (issue #96), then SPA-navigates to the parent
 * with `focus=last` so the caret lands on the new last child. Mirrors `/today`
 * (ADR 0041): session-gated by AuthGate, collection started via subscribeTree,
 * no hard reload after create.
 *
 * - `text` (required after trim) — bullet body
 * - `parentId` (optional) — append under that node; omit → today's daily note
 *   (seed-free get-or-create — we add a real bullet, not a blank entry line)
 */
export const Route = createFileRoute("/add")({
  validateSearch: (search: Record<string, unknown>) => {
    const text =
      typeof search.text === "string" ? search.text.trim() : "";
    const parentId =
      typeof search.parentId === "string" && search.parentId.trim()
        ? search.parentId.trim()
        : undefined;
    return { text, parentId };
  },
  component: AddRedirect,
});

function AddRedirect() {
  const navigate = useNavigate();
  const { text, parentId: parentIdParam } = Route.useSearch();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Start the tree store's sync socket (same as /today) so toArrayWhenReady
    // resolves — this route never mounts OutlineEditor.
    const unsub = subscribeTree(() => {});

    void (async () => {
      try {
        if (!text) {
          toast.error("Nothing to add — pass ?text=…");
          navigate({ to: "/", replace: true });
          return;
        }

        await nodesCollection.toArrayWhenReady();
        let index = buildTreeIndex(nodesCollection.toArray);

        let parentId: string | null = null;
        if (parentIdParam) {
          if (!index.byId.has(parentIdParam)) {
            toast.error("That parent node doesn't exist");
            navigate({ to: "/", replace: true });
            return;
          }
          // Mirror parents resolve to the true source (MCP planAddNode parity).
          parentId = trueSourceOf(index, parentIdParam);
        } else {
          // Default destination = today's daily note (issue #96 product call).
          // seedEntryLine stays false: we're inserting a real bullet.
          const dayId = await getOrCreateDay(localDateKey(), index);
          if (!dayId) {
            toast.error("Couldn't open today's daily note");
            navigate({ to: "/", replace: true });
            return;
          }
          parentId = dayId;
          // Day may have just been created — rebuild before sibling chain math.
          index = buildTreeIndex(nodesCollection.toArray);
        }

        const kids = childrenOf(index, parentId);
        const after = kids.length ? kids[kids.length - 1]!.id : null;
        runStructural(() => appendChild(parentId, after, text));

        // SPA navigate only — hard reload would abort the in-flight batch
        // (same load-bearing comment as /today, ADR 0041).
        navigate({
          to: "/$nodeId",
          params: { nodeId: parentId },
          search: { focus: "last" },
          replace: true,
        });
      } catch {
        navigate({ to: "/", replace: true });
      } finally {
        unsub();
      }
    })();
  }, [navigate, text, parentIdParam]);

  return null;
}
