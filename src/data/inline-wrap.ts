// Pure marker-toggle planner (ADR 0036). The shared math behind wrapping a
// selection in a marker pair (`**`/`**`, `*`/`*`, `==`/`==`, ...) AND toggling
// it back off -- the selection formatting toolbar's core, reused by the
// emphasis/highlight keymap + slash commands so a visible toolbar button and a
// hotkey behave identically. DOM-FREE and side-effect-free on purpose: the
// `document.activeElement` + caret plumbing lives in `components/wrap.ts`, so
// the interesting cases (single-vs-double marker disambiguation, the two ways a
// selection can already be wrapped) are unit-testable under `bun test`.

import { emphasisAt } from "./emphasis";

/** One marker pair. `pre`/`post` are equal-length for every current consumer
 *  but kept separate so a future asymmetry doesn't force an API change.
 *  Lives here (the pure leaf) and is re-exported from `wrap.ts` for the plugins
 *  that already import it there. */
export interface MarkerPair {
  pre: string;
  post: string;
}

function runLength(
  text: string,
  at: number,
  step: number,
  char: string | undefined,
) {
  let count = 0;
  while (at >= 0 && at < text.length && text[at] === char) {
    count++;
    at += step;
  }
  return count;
}

/** How the selection `[start, end)` of `source` is already wrapped by `m`:
 *  - `"inside"`  -- the selection ITSELF spans both markers (`**bold**` selected
 *    whole, e.g. a folded emphasis atom picked up by a drag-select).
 *  - `"outside"` -- the markers flank the selection (`bold` selected inside a
 *    revealed `**bold**`).
 *  - `null`      -- not wrapped by this marker.
 *
 *  A single-char marker (`*`, `~`) must NOT report a match on a DOUBLED marker
 *  of the same char (`**`, `~~`) -- otherwise selecting `**bold**` would read as
 *  italic too. The guards below reject a match when the neighbouring char just
 *  repeats the marker char. Double-char markers can't over-match a single, so
 *  they need no guard. */
function detectExactWrap(
  source: string,
  start: number,
  end: number,
  m: MarkerPair,
): "inside" | "outside" | null {
  const preC = m.pre[0];
  const postC = m.post[m.post.length - 1];

  // INSIDE: the selection includes both markers.
  const sel = source.slice(start, end);
  if (
    sel.length > m.pre.length + m.post.length &&
    sel.startsWith(m.pre) &&
    sel.endsWith(m.post)
  ) {
    const preOk = m.pre.length > 1 || runLength(sel, 0, 1, preC) % 2 === 1;
    const postOk =
      m.post.length > 1 || runLength(sel, sel.length - 1, -1, postC) % 2 === 1;
    if (preOk && postOk) return "inside";
  }

  // OUTSIDE: the markers sit just beyond the selection edges.
  if (
    end > start &&
    start >= m.pre.length &&
    source.slice(start - m.pre.length, start) === m.pre &&
    source.slice(end, end + m.post.length) === m.post
  ) {
    const preOk =
      m.pre.length > 1 || runLength(source, start - 1, -1, preC) % 2 === 1;
    const postOk =
      m.post.length > 1 || runLength(source, end, 1, postC) % 2 === 1;
    if (preOk && postOk) return "outside";
  }

  return null;
}

// Underscore spellings are aliases, not separate toolbar styles. Keep the
// actual matched pair so toggle-off removes the spelling the author used.
function matchingWrap(
  source: string,
  start: number,
  end: number,
  marker: MarkerPair,
) {
  const alias = marker.pre === "*" ? "_" : marker.pre === "**" ? "__" : null;
  for (const pair of alias ? [marker, { pre: alias, post: alias }] : [marker]) {
    const mode = detectExactWrap(source, start, end, pair);
    if (mode) {
      if (pair.pre.startsWith("_")) {
        const from = mode === "inside" ? start : start - pair.pre.length;
        const to = mode === "inside" ? end : end + pair.post.length;
        const run = emphasisAt(source, from);
        if (run?.end !== to) continue;
      }
      return { marker: pair, mode };
    }
  }
  return null;
}

export function detectMarkerWrap(
  source: string,
  start: number,
  end: number,
  marker: MarkerPair,
) {
  return matchingWrap(source, start, end, marker)?.mode ?? null;
}

/** The result of planning a toggle: the new source, the selection to restore in
 *  the NEW source's offsets, and whether this was an unwrap (`removed`) or a
 *  wrap. The restored selection covers the (now unmarked / now inner) text so a
 *  second press toggles it straight back and the toolbar button stays lit. */
export interface WrapPlan {
  next: string;
  range: { start: number; end: number };
  removed: boolean;
}

/** Plan a toggle of `m` over `[start, end)` of `source`. Unwraps if already
 *  wrapped (either detection mode), otherwise wraps. With an empty selection it
 *  inserts an empty pair and returns a collapsed caret inside it (the `/bold`
 *  case). Pure -- the caller writes `next` and restores `range`. */
export function planMarkerToggle(
  source: string,
  start: number,
  end: number,
  m: MarkerPair,
): WrapPlan {
  const wrap = matchingWrap(source, start, end, m);
  const mode = wrap?.mode;
  m = wrap?.marker ?? m;

  if (mode === "inside") {
    const sel = source.slice(start, end);
    const inner = sel.slice(m.pre.length, sel.length - m.post.length);
    return {
      next: source.slice(0, start) + inner + source.slice(end),
      range: { start, end: start + inner.length },
      removed: true,
    };
  }

  if (mode === "outside") {
    return {
      next:
        source.slice(0, start - m.pre.length) +
        source.slice(start, end) +
        source.slice(end + m.post.length),
      range: { start: start - m.pre.length, end: end - m.pre.length },
      removed: true,
    };
  }

  // Wrap on. Empty selection -> empty pair with a collapsed caret inside.
  const interior = source.slice(start, end);
  const innerStart = start + m.pre.length;
  return {
    next:
      source.slice(0, start) + m.pre + interior + m.post + source.slice(end),
    range: { start: innerStart, end: innerStart + interior.length },
    removed: false,
  };
}
