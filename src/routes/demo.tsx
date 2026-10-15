import { Navigate, createFileRoute } from "@tanstack/react-router";

// The landing page's live demo enters here. The demo backend was installed at
// boot (src/demo/install.ts), so the outline at `/` is the in-memory one.
export const Route = createFileRoute("/demo")({
  component: () => <Navigate to="/" replace />,
});
