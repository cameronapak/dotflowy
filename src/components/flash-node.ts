/**
 * Visual "acted-upon" marker. Adds a one-shot fade class (`.node-acted`, defined
 * in styles.css) to a row so its background pulses `bg-card` and fades back to
 * transparent -- a signifier that an action just landed on this bullet (a moved
 * node, or the node you jumped to via /move's "Go"). Purely visual: the class is
 * cleared on animationend, so a later action can re-trigger it.
 *
 * It also carries a flash request ACROSS a navigation. /move's "Go" jumps to the
 * destination's zoom view; the freshly-mounted editor consumes the pending id to
 * focus and flash the node that was moved. A module-level var (consumed once)
 * rather than history state, so it fires exactly once -- not on every back/forward
 * to that entry.
 */

let pendingAfterNav: string | null = null;

/** Ask the next-mounted editor to focus + flash `id`. Consumed once. */
export function requestFlashAfterNav(id: string) {
  pendingAfterNav = id;
}

/** Read and clear any pending post-navigation flash request. */
export function consumeFlashAfterNav(): string | null {
  const id = pendingAfterNav;
  pendingAfterNav = null;
  return id;
}

/** Pulse a row's background, restarting the animation if it's mid-flight. */
export function flashRow(row: Element | null) {
  if (!(row instanceof HTMLElement)) return;
  row.classList.remove("node-acted");
  // Force a reflow so re-adding the class restarts the animation from the top.
  void row.offsetWidth;
  row.classList.add("node-acted");
  row.addEventListener(
    "animationend",
    () => row.classList.remove("node-acted"),
    { once: true },
  );
}

/**
 * Shake a row side-to-side to signal a *rejected* action -- the bullet can't be
 * deleted (a protected node). The "no" gesture a password field gives a wrong
 * entry. Mirrors `flashRow`'s one-shot-class mechanic: add `.node-rejected`,
 * clear it on animationend so it can re-trigger. Under `prefers-reduced-motion`
 * the CSS swaps the shake for a brief destructive-tint pulse (which still emits
 * animationend) -- so reduced-motion users still get feedback, not silence.
 */
export function rejectRow(row: Element | null) {
  if (!(row instanceof HTMLElement)) return;
  row.classList.remove("node-rejected");
  // Force a reflow so re-adding the class restarts the animation from the top.
  void row.offsetWidth;
  row.classList.add("node-rejected");
  row.addEventListener(
    "animationend",
    () => row.classList.remove("node-rejected"),
    { once: true },
  );
}
