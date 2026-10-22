// The pure string core of token write-back, split out from `token-kit.ts` so it
// carries ZERO imports. `token-kit.ts` also holds DOM helpers (it imports the
// tree store, view state, and `OutlineRow`'s JSX types), so any module that
// pulls a helper out of it drags the whole DOM surface along. The worker
// compilation reaches this function through `src/data/{links,highlight}.ts` and
// `route-bible/bible.ts` (via OPML import/export), and the Workers-types
// tsconfig has no DOM lib — so `spliceToken` must live where nothing DOM-shaped
// can ride in. Keep this file dependency-free.

/** Splice a verbatim token replacement into `text` at its first occurrence, or
 *  null if the token is no longer present (it was edited/deleted since). The
 *  pure core of every token write-back. */
export function spliceToken(
  text: string,
  oldToken: string,
  newToken: string,
): string | null {
  const at = text.indexOf(oldToken);
  if (at < 0) return null;
  return text.slice(0, at) + newToken + text.slice(at + oldToken.length);
}
