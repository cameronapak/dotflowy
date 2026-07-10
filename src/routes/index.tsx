import { createFileRoute } from "@tanstack/react-router";

import { OutlineEditor } from "../components/OutlineEditor";
import { validateOutlineSearch } from "../data/tags";

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: validateOutlineSearch,
});

function HomePage() {
  return (
    <main>
      <OutlineEditor rootId={null} />
    </main>
  );
}
