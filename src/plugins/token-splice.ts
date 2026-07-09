// The pure string core of token write-back, split out from `token-kit.ts` so it
// carries ZERO imports. `token-kit.ts` also holds DOM helpers (it imports the
// tree store, view state, and `OutlineNode`'s JSX types), so any module that
// pulls a helper out of it drags the whole DOM surface along. The worker
// compilation reaches this function through `src/data/{links,highlight}.ts` and
// `route-bible/bible.ts` (via OPML import/export), and the Workers-types
// tsconfig has no DOM lib — so `spliceToken` must live where nothing DOM-shaped
// can ride in. Keep this file dependency-free.

/** Splice a verbatim token replacement into `text` at the first occurrence
 *  at-or-after `searchFrom`, or null if the token is no longer present there (it
 *  was edited/deleted since). The pure core of every token write-back.
 *
 *  `searchFrom` disambiguates repeated tokens: when one line holds two identical
 *  sources (e.g. two `John 3` chips), the caller passes the clicked token's
 *  source offset so the edit lands on the chip that was actually clicked, not
 *  always the first. Defaults to 0 (first occurrence) for callers that can't
 *  repeat within a line or don't track which one was hit. */
export function spliceToken(
  text: string,
  oldToken: string,
  newToken: string,
  searchFrom = 0,
): string | null {
  const at = text.indexOf(oldToken, Math.max(0, searchFrom));
  if (at < 0) return null;
  return text.slice(0, at) + newToken + text.slice(at + oldToken.length);
}
