import { useEffect, useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { nodesCollection } from "../data/collection";
import { subscribeTree } from "../data/tree-store";
import { buildTreeIndex } from "../data/tree";
import { localDateKey } from "../plugins/daily/daily-index";
import { getOrCreateDay } from "../plugins/daily";

export const Route = createFileRoute("/today")({
  component: TodayRedirect,
});

function TodayRedirect() {
  const navigate = useNavigate();
  const redirectStarted = useRef(false);

  useEffect(() => {
    if (redirectStarted.current) return;
    redirectStarted.current = true;

    // Subscribe to the tree store so the nodes collection's sync starts
    // (the WebSocket opens on the first subscribeChanges call, gated by
    // tree-store's ensureStarted). Without this, toArrayWhenReady hangs --
    // no other component on this route touches the store.
    const unsub = subscribeTree(() => {});

    void (async () => {
      try {
        await nodesCollection.toArrayWhenReady();
        const index = buildTreeIndex(nodesCollection.toArray);
        // /today is a write-intent surface (ADR 0041): seed an empty entry line
        // so the caret has somewhere to land, and focus=last puts it there.
        const dayId = await getOrCreateDay(localDateKey(), index, {
          seedEntryLine: true,
        });
        if (dayId) {
          // Client-side (SPA) navigate, NOT window.location.replace: a hard
          // reload tears down the Effect runtime + sync socket and aborts the
          // structural write that just created the day -- runStructural resolves
          // on the optimistic insert, not the durable commit, so getOrCreateDay
          // returns while `POST /api/nodes {ops}` is still in flight. Staying in
          // the SPA lets that write finish and lands in the live editor with the
          // day already present, so ?focus=last takes effect. `replace` keeps
          // /today out of history (no redirect trap on Back).
          navigate({
            to: "/$nodeId",
            params: { nodeId: dayId },
            search: { focus: "last" },
            replace: true,
          });
        } else {
          toast.error("Couldn't open today's daily note");
          navigate({ to: "/", replace: true });
        }
      } catch {
        navigate({ to: "/", replace: true });
      } finally {
        unsub();
      }
    })();
  }, [navigate]);

  return null;
}
