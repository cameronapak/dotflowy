import { createFileRoute } from "@tanstack/react-router";

import { OutlineEditor } from "../components/OutlineEditor";
import { validateOutlineSearch } from "../data/tags";

export const Route = createFileRoute("/$nodeId")({
  component: ZoomedPage,
  validateSearch: validateOutlineSearch,
});

function ZoomedPage() {
  const { nodeId } = Route.useParams();
  return (
    <main>
      {/* Key by node id so each zoom view mounts a fresh title element;
          prevents a suppressed view-transition-name from leaking between
          consecutive zooms. */}
      <OutlineEditor key={nodeId} rootId={nodeId} />
    </main>
  );
}
