import { Outlet } from "react-router";
import "./App.css";

// Root component wrapping every page (set via client.rootComponent in
// main.wasp.ts). Kept minimal for Phase 1; the editor chrome arrives in Phase 3.
export function App() {
  return (
    <main className="min-h-screen w-full bg-neutral-50 text-neutral-900">
      <Outlet />
    </main>
  );
}
