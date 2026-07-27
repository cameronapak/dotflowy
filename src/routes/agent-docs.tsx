import { createFileRoute } from "@tanstack/react-router";

// Public agent protocol notes (docs/agent-docs.md). Join prompt → `/agent-docs`
// (ADR 0059). Raw mirror at public/agent-docs.md for agent fetch. Outside AuthGate.
import agentDocsMarkdown from "../../docs/agent-docs.md?raw";
import { LegalPage } from "../components/legal-page";

export const Route = createFileRoute("/agent-docs")({
  head: () => ({
    meta: [{ title: "Bring your own agent — Dotflowy" }],
  }),
  component: AgentDocs,
});

function AgentDocs() {
  return <LegalPage markdown={agentDocsMarkdown} />;
}
