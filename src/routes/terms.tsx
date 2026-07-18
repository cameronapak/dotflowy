import { createFileRoute } from "@tanstack/react-router";

// The committed legal draft (docs/legal/terms.md), bundled as a raw string at
// build time. Rendered by the shared LegalPage; this route is PUBLIC — see
// __root.tsx's PUBLIC_ROUTES, which renders it OUTSIDE the AuthGate so a
// signed-out visitor can read it.
import termsMarkdown from "../../docs/legal/terms.md?raw";
import { LegalPage } from "../components/legal-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [{ title: "Terms of Service — Dotflowy" }],
  }),
  component: Terms,
});

function Terms() {
  return <LegalPage markdown={termsMarkdown} />;
}
