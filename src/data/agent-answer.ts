/**
 * Split a completed agent reply into the ADR 0059 answer tree shape:
 * first non-empty line → summary child; remainder → collapsed detail.
 */

export type AgentAnswerParts = {
  summary: string;
  detail: string;
};

/** Empty / whitespace-only model output still needs a summary node. */
const EMPTY_SUMMARY = "(no answer)";

export function splitAgentAnswer(fullText: string): AgentAnswerParts {
  const text = fullText.replace(/\r\n/g, "\n").trim();
  if (!text) return { summary: EMPTY_SUMMARY, detail: "" };

  const nl = text.indexOf("\n");
  if (nl === -1) return { summary: text, detail: "" };

  const summary = text.slice(0, nl).trim();
  const detail = text.slice(nl + 1).trim();
  return {
    summary: summary || EMPTY_SUMMARY,
    detail,
  };
}
