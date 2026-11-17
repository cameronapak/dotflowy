// Inline emphasis grammar shared by the editor, search, and OPML export.
// Delimiter runs need a balanced scan, not a flat regex: `*a **b** c*`
// and `**a *b* c**` use the same characters for different nesting levels.
import { CODE_RUN_PATTERN } from "./code";
import { HIGHLIGHT_PATTERN } from "./highlight";
import { LINK_PATTERN } from "./links";
import { SPOILER_PATTERN } from "./spoiler";

/** Candidate opening runs. `emphasisAt` resolves their balanced extent. */
export const EMPHASIS_PATTERN = "\\*+|_+|~+";

export interface EmphasisRun {
  start: number;
  end: number;
  marker: string;
  kind: "bold" | "italic" | "strike" | "underline";
}

const punctuation = /[\p{P}\p{S}]/u;
const whitespace = /\s/u;
// These complete containers shield their marker characters from an enclosing
// emphasis delimiter. Their own renderers decide whether to parse interiors.
const shield = new RegExp(
  [CODE_RUN_PATTERN, LINK_PATTERN, HIGHLIGHT_PATTERN, SPOILER_PATTERN].join(
    "|",
  ),
  "uy",
);

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

function delimiter(text: string, start: number) {
  const char = text[start]!;
  let end = start + 1;
  while (text[end] === char) end++;
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  const beforeSpace = !before || whitespace.test(before);
  const afterSpace = !after || whitespace.test(after);
  const beforePunct = punctuation.test(before);
  const afterPunct = punctuation.test(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return {
    end,
    length: end - start,
    // Underscores cannot open or close inside words. Asterisks may.
    opens: left && (char !== "_" || !right || beforePunct),
    closes: right && (char !== "_" || !left || afterPunct),
  };
}

// Keep only the current source's failed opener positions. A failed balanced
// scan also proves its still-open, opening-only delimiters cannot close, so
// later candidates need not rescan the same suffix. Dual-purpose delimiters
// depend on the surrounding stack and must be retried. Bound storage to one source.
let failedSource = "";
let failedOpeners = new Set<number>();

/** A complete emphasis container beginning exactly at `start`, or null.
 * Offsets and marker widths are UTF-16 source positions, like the editor.
 * Balanced runs allow shared closing fences and arbitrary nesting depth.
 * Code and other complete containers cannot accidentally close this run. */
export function emphasisAt(text: string, start: number): EmphasisRun | null {
  if (text !== failedSource) {
    failedSource = text;
    failedOpeners = new Set();
  }
  if (failedOpeners.has(start)) return null;
  const char = text[start];
  if ((char !== "*" && char !== "_" && char !== "~") || escaped(text, start))
    return null;
  const opening = delimiter(text, start);
  if (!opening.opens) return null;
  const stack = [{ length: opening.length, closes: opening.closes, start }];
  let markerLength = opening.length % 2 || 2;
  for (let at = opening.end; at < text.length;) {
    if (text[at] === "\n") break;
    if (escaped(text, at)) {
      at++;
      continue;
    }
    if (
      text[at] === "`" ||
      text[at] === "[" ||
      text[at] === "=" ||
      text[at] === "|"
    ) {
      shield.lastIndex = at;
      const opaque = shield.exec(text);
      if (opaque) {
        at += opaque[0].length;
        continue;
      }
    }
    if (text[at] !== char) {
      at++;
      continue;
    }
    const next = delimiter(text, at);
    let remaining = next.length;
    if (next.closes) {
      while (remaining && stack.length) {
        let top = stack.length - 1;
        // A dual-purpose delimiter cannot pair with a run whose total is a
        // multiple of three (unless both are). This keeps the middle `*` in
        // `**foo*bar**` literal, while allowing `*foo**bar**baz*` to nest.
        while (top >= 0) {
          const candidate = stack[top]!;
          if (
            !(next.opens || candidate.closes) ||
            (candidate.length + next.length) % 3 !== 0 ||
            (candidate.length % 3 === 0 && next.length % 3 === 0)
          )
            break;
          top--;
        }
        if (top < 0) break;
        const candidate = stack[top]!;
        const used = candidate.length >= 2 && remaining >= 2 ? 2 : 1;
        candidate.length -= used;
        remaining -= used;
        // Unpaired inner openers remain literal inside the completed run.
        stack.length = candidate.length ? top + 1 : top;
        if (candidate.length && top === 0)
          markerLength = Math.min(2, candidate.length);
      }
      if (!stack.length) {
        const marker = char.repeat(markerLength);
        return {
          start,
          end: next.end - remaining,
          marker,
          kind:
            char === "~"
              ? markerLength === 2
                ? "strike"
                : "underline"
              : markerLength === 2
                ? "bold"
                : "italic",
        };
      }
    }
    if (remaining && next.opens)
      stack.push({ length: remaining, closes: next.closes, start: at });
    at = next.end;
  }
  for (const opener of stack) {
    if (!opener.closes) failedOpeners.add(opener.start);
  }
  return null;
}

/** Plain reading text, recursively dropping recognized emphasis fences.
 * The caller's code shielding preserves literal code interiors. */
export function stripEmphasis(text: string): string {
  if (!text.includes("*") && !text.includes("_") && !text.includes("~"))
    return text;
  const re = new RegExp(EMPHASIS_PATTERN, "gu");
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const run = emphasisAt(text, m.index);
    if (!run) continue;
    out += text.slice(last, run.start);
    out += stripEmphasis(
      text.slice(run.start + run.marker.length, run.end - run.marker.length),
    );
    last = re.lastIndex = run.end;
  }
  return out + text.slice(last);
}
