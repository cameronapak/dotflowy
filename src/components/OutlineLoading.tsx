/**
 * The loading indicator shown while the first sync frame is in flight (gated by
 * `useSyncReady` in OutlineEditor). It exists to kill the first-render flash: the
 * outline used to paint zero rows, then jump to the full tree the instant the
 * snapshot landed. Holding a quiet spinner until sync is ready means the real rows
 * animate IN (`.outline-reveal`) rather than popping out of an empty page.
 *
 * The wrapper fades in on a ~140ms DELAY (`.outline-loading` in styles.css):
 * animation-fill-mode `both` holds opacity 0 through the delay, so a fast snapshot
 * (the common case) swaps to real content before the spinner is ever visible -- no
 * spinner flash. Only a genuinely slow load reveals it.
 *
 * A pure presentational leaf: no store reads, no node ids. It is never on the
 * keystroke path (it's unmounted the moment sync is ready).
 */
export function OutlineLoading() {
  return (
    <div className="outline-loading" role="status" aria-label="Loading outline">
      <span className="outline-spinner" />
    </div>
  );
}
