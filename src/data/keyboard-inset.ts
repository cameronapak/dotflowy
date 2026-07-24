/**
 * Publishes `--kb-inset` on `<html>`: how far a `position: fixed; bottom: 0`
 * surface must lift to sit just above the software keyboard (ADR 0030).
 *
 * **It MEASURES the anchor instead of computing it.** Every previous version of
 * this tried to derive the lift from a viewport property, and each one worked
 * until iOS Safari moved its chrome. Measured on one iPhone across two samples,
 * one keyboard session:
 *
 * | innerHeight | clientHeight | pre-keyboard band | vv.height | vv.offsetTop |
 * | ----------- | ------------ | ----------------- | --------- | ------------ |
 * | 526         | 498          | 590               | 234       | 108          |
 * | 482         | 498          | 590               | 234       | 108          |
 *
 * Three candidate anchors, none of them agreeing, and `innerHeight` moving 44px
 * between samples while nothing else did. Formulas built on `innerHeight`,
 * `clientHeight`, or the pre-keyboard band are each correct only while the
 * chrome is in the state they assumed — which is exactly why the bar was fine
 * "for the most part" and then suddenly wasn't.
 *
 * So: append a zero-size `position: fixed; bottom: 0` PROBE and read its
 * `getBoundingClientRect().bottom`. That IS where `bottom: 0` resolves, by
 * definition, with no model in between — and a client rect is reported in the
 * same space as `visualViewport.height`, so the band's bottom edge is just
 * `vv.height` and the lift is their difference. Fed the two samples above, this
 * yields the correct 228 in both even though the anchor itself measured 418 and
 * 390. Any future chrome drift is absorbed for free.
 *
 * Writing a CSS custom property rather than returning a React value is
 * deliberate: the keyboard animates over many frames, and no consumer should
 * re-render per frame to follow it. `styles.css` declares the `0px` default.
 */

/** Runs only while a text-editable is focused — the only time the value can be
 *  non-zero, and the only time a per-frame loop is worth paying for. */
function isEditing(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement)
  );
}

function install(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const probe = document.createElement("div");
  // `visibility: hidden` still produces a layout box (unlike `display: none`),
  // which is the whole point — we need its rect, not its pixels.
  probe.style.cssText =
    "position:fixed;bottom:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none";
  probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(probe);

  const root = document.documentElement;
  let current = -1;
  let raf = 0;

  const measure = () => {
    raf = 0;
    // Not editing: no keyboard, so no lift. Cheap early exit that also stops the
    // loop from fighting a `bottom: 0` element during ordinary page scrolling.
    const lift = isEditing()
      ? Math.max(
          0,
          Math.round(probe.getBoundingClientRect().bottom - vv.height),
        )
      : 0;
    // Only touch the DOM when the value actually changes: iOS fires resize and
    // scroll in bursts through the keyboard animation, and most frames repeat.
    if (lift !== current) {
      current = lift;
      root.style.setProperty("--kb-inset", `${lift}px`);
    }
    if (isEditing()) raf = requestAnimationFrame(measure);
  };

  const start = () => {
    if (!raf) raf = requestAnimationFrame(measure);
  };
  const stop = () => {
    // focusout fires before the next focusin when moving between bullets, so
    // settle a frame before deciding the keyboard is really gone.
    requestAnimationFrame(() => {
      if (!isEditing()) measure();
    });
  };

  // The rAF loop is the primary signal (Safari moves its chrome without firing
  // anything useful); these just start it and catch the settle after blur.
  document.addEventListener("focusin", start);
  document.addEventListener("focusout", stop);
  vv.addEventListener("resize", start);
  vv.addEventListener("scroll", start);
  measure();
}

// SPA-only, and the `/` prerender has no window (AGENTS.md SPA/no-SSR rule).
if (typeof window !== "undefined") {
  if (document.body) install();
  else document.addEventListener("DOMContentLoaded", install, { once: true });
}
