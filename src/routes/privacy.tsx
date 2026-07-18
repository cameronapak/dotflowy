import { createFileRoute } from "@tanstack/react-router";

// The committed legal draft (docs/legal/privacy.md), bundled as a raw string at
// build time. Rendered by the shared LegalPage; this route is PUBLIC — see
// __root.tsx's PUBLIC_ROUTES, which renders it OUTSIDE the AuthGate so a
// signed-out visitor can read it.
import privacyMarkdown from "../../docs/legal/privacy.md?raw";
import { LegalPage } from "../components/legal-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [{ title: "Privacy Policy — Dotflowy" }],
  }),
  component: Privacy,
});

function Privacy() {
  return <LegalPage markdown={privacyMarkdown} />;
}
