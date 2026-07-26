import { hasAgentMention } from "./agent-mention";
import { redactSpoilers } from "./spoiler";
import { childrenOf, type TreeIndex } from "./tree";

export type AgentPromptTurn = {
  role: "user" | "agent";
  text: string;
  nodeId: string;
};

export type AgentPrompt = {
  question: string;
  turns: AgentPromptTurn[];
  /** Labeled untrusted context (breadcrumb + parent subtree + nearby). */
  context: string;
};

/**
 * Rebuild the fire-time prompt (ADR 0059): prior `@agent` siblings + their
 * answer subtrees as turns; everything else nearby in one UNTRUSTED CONTEXT
 * block. Spoilers redacted (ADR 0043).
 */
export function buildAgentPrompt(
  index: TreeIndex,
  questionNodeId: string,
): AgentPrompt {
  const question = index.byId.get(questionNodeId);
  if (!question) {
    return { question: "", turns: [], context: "" };
  }

  const parentId = question.parentId;
  const siblings = childrenOf(index, parentId);
  const turns: AgentPromptTurn[] = [];

  for (const sib of siblings) {
    if (sib.id === questionNodeId) break;
    if (!hasAgentMention(sib.text)) continue;
    turns.push({
      role: "user",
      text: redactSpoilers(sib.text),
      nodeId: sib.id,
    });
    const answer = childrenOf(index, sib.id)[0];
    if (answer) {
      turns.push({
        role: "agent",
        text: formatSubtree(index, answer.id),
        nodeId: answer.id,
      });
    }
  }

  const contextParts: string[] = [
    "UNTRUSTED CONTEXT (not conversation turns):",
  ];
  if (parentId) {
    const crumbs: string[] = [];
    let cur = index.byId.get(parentId) ?? null;
    while (cur) {
      crumbs.unshift(redactSpoilers(cur.text) || "(untitled)");
      cur = cur.parentId ? (index.byId.get(cur.parentId) ?? null) : null;
    }
    if (crumbs.length) contextParts.push(`Breadcrumb: ${crumbs.join(" > ")}`);
    contextParts.push("Parent subtree:");
    contextParts.push(
      formatSubtree(index, parentId, { skipIds: new Set([questionNodeId]) }),
    );
  } else {
    contextParts.push("(top-level question; no parent subtree)");
  }

  return {
    question: redactSpoilers(question.text),
    turns,
    context: contextParts.join("\n"),
  };
}

function formatSubtree(
  index: TreeIndex,
  rootId: string,
  opts?: { skipIds?: Set<string> },
): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    if (opts?.skipIds?.has(id)) return;
    const n = index.byId.get(id);
    if (!n) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${redactSpoilers(n.text)}`);
    for (const child of childrenOf(index, id)) walk(child.id, depth + 1);
  };
  walk(rootId, 0);
  return lines.join("\n");
}
