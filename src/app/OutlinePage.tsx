import { useParams } from "react-router";
import { OutlineEditor } from "../components/OutlineEditor";

/**
 * The outline editor page, shared by `/` (rootId = null, the whole outline) and
 * `/:nodeId` (zoomed to that node). `rootId` is route-owned — read from the URL
 * param here, never editor-local zoom state.
 *
 * Keyed by root so each zoom view mounts a fresh title element (ADR 0003):
 * prevents a suppressed view-transition-name from leaking between consecutive
 * zooms, and lets the editor's mount-only effects re-run per view.
 */
export function OutlinePage() {
  const { nodeId } = useParams();
  const rootId = nodeId ?? null;
  return <OutlineEditor key={rootId ?? "__home__"} rootId={rootId} />;
}
