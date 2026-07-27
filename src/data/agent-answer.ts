/**
 * Split a completed agent reply into the ADR 0059 answer tree shape:
 * first non-empty line → summary child; remainder → markdown forest of
 * grandchildren (list markers → bullets/tasks, bare lines → paragraphs).
 *
 * Inline emphasis (`**bold**`, etc.) stays in `text` as folding tokens —
 * only block structure is parsed (via `parseMarkdownForest`, ADR 0044).
 */

import type { NodeKind } from "./tree";

import { parseMarkdownForest, type MdNode } from "./markdown-import";

export type { MdNode as AgentAnswerNode };

export type AgentAnswerParts = {
  summary: string;
  /** Raw remainder (joined lines); empty when summary-only. */
  detail: string;
  /** Parsed detail forest; empty when summary-only. */
  detailForest: MdNode[];
};

/** One planned insert for `commitAgentAnswer` / the e2e mock (pre-order). */
export type AgentForestInsert = {
  id: string;
  parentId: string;
  text: string;
  isTask: boolean;
  completed: boolean;
  kind: NodeKind;
  /** True when the node has children — nested detail starts folded. */
  collapsed: boolean;
};

/** Empty / whitespace-only model output still needs a summary node. */
const EMPTY_SUMMARY = "(no answer)";

export function splitAgentAnswer(fullText: string): AgentAnswerParts {
  const text = fullText.replace(/\r\n/g, "\n").trim();
  if (!text) {
    return { summary: EMPTY_SUMMARY, detail: "", detailForest: [] };
  }

  const nl = text.indexOf("\n");
  if (nl === -1) {
    return { summary: text, detail: "", detailForest: [] };
  }

  const summary = text.slice(0, nl).trim();
  const detail = text.slice(nl + 1).trim();
  return {
    summary: summary || EMPTY_SUMMARY,
    detail,
    detailForest: detail ? parseMarkdownForest(detail) : [],
  };
}

/**
 * Pre-order flatten of a detail forest with freshly minted ids. Parents are
 * emitted before children so sequential `planAppendChild` walks stay valid.
 */
export function materializeAgentDetailForest(
  forest: readonly MdNode[],
  parentId: string,
  newId: () => string,
): AgentForestInsert[] {
  const out: AgentForestInsert[] = [];
  const walk = (nodes: readonly MdNode[], parent: string) => {
    for (const md of nodes) {
      const id = newId();
      out.push({
        id,
        parentId: parent,
        text: md.text,
        isTask: md.isTask,
        completed: md.completed,
        kind: md.kind,
        collapsed: md.children.length > 0,
      });
      if (md.children.length) walk(md.children, id);
    }
  };
  walk(forest, parentId);
  return out;
}
