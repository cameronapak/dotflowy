import { useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
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
        const dayId = await getOrCreateDay(localDateKey(), index);
        if (dayId) {
          window.location.replace(`/${dayId}?focus=last`);
        } else {
          toast.error("Couldn't open today's daily note");
          window.location.replace("/");
        }
      } catch {
        window.location.replace("/");
      } finally {
        unsub();
      }
    })();
  }, []);

  return null;
}
