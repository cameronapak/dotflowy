// The pure string core of token write-back, split out from `token-kit.ts` so it
// carries ZERO imports. `token-kit.ts` also holds DOM helpers (it imports the
// tree store, view state, and `OutlineNode`'s JSX types), so any module that
// pulls a helper out of it drags the whole DOM surface along. The worker
// compilation reaches this function through `src/data/{links,highlight}.ts` and
// `route-bible/bible.ts` (via OPML import/export), and the Workers-types
// tsconfig has no DOM lib — so `spliceToken` must live where nothing DOM-shaped
// can ride in. Keep this file dependency-free.

/** Splice a verbatim token replacement into `text`, or null if the token is no
 *  longer where the caller saw it (it was edited/deleted since). The pure core
 *  of every token write-back.
 *
 *  `searchFrom` disambiguates repeated tokens: when one line holds two identical
 *  sources (e.g. two `John 3` chips), the caller passes the clicked token's
 *  source offset and the token must still start EXACTLY there — if a concurrent
 *  edit (remote sync, MCP agent) shifted the text while the editor was open, the
 *  write drops (null) rather than landing on a different occurrence than the one
 *  clicked. Defaults to 0, which keeps the original first-occurrence behavior
 *  for callers that can't repeat within a line or don't track which one was
 *  hit. */
export function spliceToken(
  text: string,
  oldToken: string,
  newToken: string,
  searchFrom = 0,
): string | null {
  const at =
    searchFrom > 0
      ? text.startsWith(oldToken, searchFrom)
        ? searchFrom
        : -1
      : text.indexOf(oldToken);
  if (at < 0) return null;
  return text.slice(0, at) + newToken + text.slice(at + oldToken.length);
}
