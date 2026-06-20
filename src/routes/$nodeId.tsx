import { createFileRoute } from "@tanstack/react-router";
import { OutlineEditor } from "../components/OutlineEditor";

export const Route = createFileRoute("/$nodeId")({
  component: ZoomedPage,
});

function ZoomedPage() {
  const { nodeId } = Route.useParams();
  return (
    <main className="app">
      {/* Key by node id so each zoom view mounts a fresh title element;
          prevents a suppressed view-transition-name from leaking between
          consecutive zooms. */}
      <OutlineEditor key={nodeId} rootId={nodeId} />
    </main>
  );
}
