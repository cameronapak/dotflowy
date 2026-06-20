import { createFileRoute } from "@tanstack/react-router";
import { OutlineEditor } from "../components/OutlineEditor";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="app">
      <OutlineEditor rootId={null} />
    </main>
  );
}
