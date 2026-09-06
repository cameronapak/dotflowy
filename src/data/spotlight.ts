/**
 * Spotlight focus mode (ADR 0033). When enabled, the outline dims to 0.3 while a
 * bullet is focused -- EXCEPT that focused bullet, which stays full -- so the
 * line you're editing stands out. Single-node by design: dimmed context is still
 * legible at 0.3, so one bright line against a uniform dim field reads calmer
 * than a ladder of lit ancestors, and it matches the intent (focus on the node).
 *
 * Four halves:
 *  1. A localStorage-backed store for the on/off toggle -- the More-menu
 *     checkbox reads it via `useSpotlightEnabled`, mirroring show-completed.
 *     It's a per-browser view preference, not synced document data.
 *  2. A tiny engine that toggles two `<body>` classes: `spotlight-on` (the mode)
 *     and `spotlight-fade` (the input modality). ALL of the dim/light logic is
 *     pure CSS (`:has(.node-text:focus)` + `:focus-within`, see styles.css) --
 *     no focus listeners, no generated stylesheet, no tree walk. Single-node
 *     lighting is exactly what `:focus-within` expresses, and "dim only while a
 *     caret is in the outline" is exactly `:has(:focus)`, so CSS does both.
 *  3. Centering (ADR 0060): a focused list row slides to the vertical center of
 *     the viewport. Same modality split as the dim -- a pointer jump eases
 *     (~200ms), keyboard nav takes a short 120ms beat so fast arrowing never
 *     swims. One rAF tween, cancelled and retargeted by the next focus. No
 *     virtualizer padding wells and no compensating scrolls: edge rows clamp,
 *     and the breathing-room padding (also ADR 0060) lives in OutlineEditor.
 *  4. The breathing-room grow/collapse on toggle (ADR 0060): ONE tween drives
 *     the region's inline padding AND the window scroll in the same frames,
 *     so the anchored row stays glued to the screen. Two separate animations
 *     (a CSS padding transition plus a scroll tween) always fight -- that was
 *     the bounce. The `pt-[50vh]` class is the steady state the tween hands
 *     off to; it carries no CSS transition of its own.
 */

import { SPOTLIGHT_KEY } from "../lib/storage-keys";

// -- toggle store -----------------------------------------------------------

const listeners = new Set<() => void>();

export function subscribeSpotlight(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SPOTLIGHT_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSpotlightSnapshot(): boolean {
  try {
    return window.localStorage.getItem(SPOTLIGHT_KEY) === "true";
  } catch {
    return false;
  }
}

/** SPA/prerender has no window; spotlight is off during any server pass. */
export function getSpotlightServerSnapshot(): boolean {
  return false;
}

export function setSpotlightEnabled(next: boolean): void {
  try {
    window.localStorage.setItem(SPOTLIGHT_KEY, String(next));
  } catch {
    // localStorage can throw (private mode); the engine still toggles below.
  }
  for (const l of listeners) l();
}

// -- DOM engine -------------------------------------------------------------

const SPOTLIGHT_ON = "spotlight-on";
const SPOTLIGHT_FADE = "spotlight-fade";

let installed = false;

// The dim change eases on a pointer-driven focus and snaps on keyboard nav
// (ADR 0033): a click into a distant bullet can afford a fade, but rapid
// arrow-stepping must feel immediate. We only track the modality; CSS reacts.
const onPointerDown = () => document.body.classList.add(SPOTLIGHT_FADE);
const onKeyDown = () => document.body.classList.remove(SPOTLIGHT_FADE);

// -- centering (ADR 0060) ----------------------------------------------------

/** Keyboard takes a short beat; a pointer jump can afford a fuller ease. */
export const KEYBOARD_SLIDE_MS = 120;
export const POINTER_SLIDE_MS = 200;

/** The breathing-room grow/collapse: one beat, matching the old CSS ease. */
export const BREATH_MS = 200;

let tweenRaf = 0;

function cancelTween(): void {
  if (!tweenRaf) return;
  cancelAnimationFrame(tweenRaf);
  tweenRaf = 0;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * ONE interruptible ease-out tween. Every animated scroll goes through here,
 * so a new target cancels the previous flight instead of stacking on it
 * (rapid arrows chase the caret; they never queue). `prefers-reduced-motion`
 * snaps straight to the end.
 */
function runTween(
  ms: number,
  step: (t: number) => void,
  done?: () => void,
): void {
  cancelTween();
  if (ms <= 0 || prefersReducedMotion()) {
    step(1);
    done?.();
    return;
  }
  const started = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - started) / ms);
    step(1 - (1 - t) ** 3);
    if (t < 1) tweenRaf = requestAnimationFrame(frame);
    else {
      tweenRaf = 0;
      done?.();
    }
  };
  tweenRaf = requestAnimationFrame(frame);
}

/** Interruptible ease-out scroll. */
function slideBy(delta: number, ms: number): void {
  if (Math.abs(delta) < 1) return;
  const from = window.scrollY;
  runTween(ms, (t) => window.scrollTo(0, from + delta * t));
}

/**
 * While true, `centerElement` is a no-op. Set while the breathing-room
 * tween runs: it drives padding AND scroll in the same frames, so any
 * focus-driven centering fired underneath it would cancel it mid-grow
 * (cancelTween) and strand the padding. The tween owns the view until done.
 */
let breathAnimating = false;

/** The outline region (ADR 0060 breathing room lives on it as `pt-[50vh]`). */
function outlineRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="region"][aria-label="Outline"]',
  );
}

/** Half the viewport, matching the region's `pt-[50vh]` class. */
function breathPad(): number {
  return Math.round(window.innerHeight / 2);
}

/**
 * Grow (enable) or collapse (disable) the breathing room as ONE animation:
 * the tween drives the region's inline padding AND the window scroll in the
 * same frames, so the row the user is anchored to stays GLUED to the screen
 * while the page eases into its new shape. Two separate animations (CSS
 * padding transition + scroll tween) always fight -- each cancels or
 * overshoots the other -- which read as a bounce. Done => the inline style
 * is cleared and the steady-state class (present/absent) takes over at the
 * same value, so there is no snap at the end.
 */
function animateBreath(
  padFrom: number,
  padTo: number,
  scrollDelta: number,
): void {
  const region = outlineRegion();
  const from = window.scrollY;
  breathAnimating = true;
  if (region) {
    // The tween owns the scroll for its whole flight; the browser's scroll
    // anchoring must not "compensate" the concurrent layout change (the
    // header also resizes on toggle) -- it fires a one-frame counter-jump.
    region.style.overflowAnchor = "none";
  }
  runTween(
    BREATH_MS,
    (t) => {
      if (region)
        region.style.paddingTop = `${Math.round(padFrom + (padTo - padFrom) * t)}px`;
      window.scrollTo(0, from + scrollDelta * t);
    },
    () => {
      breathAnimating = false;
      if (region) {
        region.style.paddingTop = "";
        region.style.overflowAnchor = "";
      }
    },
  );
}

/** Distance to scroll so a row sits at the vertical center of the viewport. */
export function centerScrollDelta(
  rowTop: number,
  rowHeight: number,
  viewTop: number,
  viewHeight: number,
): number {
  return rowTop + rowHeight / 2 - (viewTop + viewHeight / 2);
}

/** Zoomed title is an h2, not a list row. Focusing it is explicit intent, so
 *  it centers too (ADR 0060) -- children return when a child is focused. */
function lineOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const title = target.closest<HTMLElement>("h2.zoomed-title");
  if (title) return title;
  const text = target.classList.contains("node-text")
    ? target
    : target.closest(".node-text");
  if (!text) return null;
  return text.closest("li[data-node-id]");
}

const onFocusIn = (e: FocusEvent) => {
  const li = lineOf(e.target);
  if (!li) return;
  // One layout pass after the browser's own focus-scroll, so the rect we read
  // is the one the user sees.
  requestAnimationFrame(() => {
    if (!installed || !li.isConnected) return;
    // A drag-select inside the row must not be yanked mid-gesture.
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && li.contains(sel.anchorNode)) return;
    centerElement(
      li,
      document.body.classList.contains(SPOTLIGHT_FADE)
        ? POINTER_SLIDE_MS
        : KEYBOARD_SLIDE_MS,
    );
  });
};

/**
 * While true, `centerElement` is a no-op: the breathing-room tween owns the
 * view (see `animateBreath`).
 */

/** Scroll `el` to the vertical center of the viewport. No-op when the engine
 *  is off, the breath tween is running, or the element has no box yet. */
export function centerElement(el: HTMLElement, ms: number): void {
  if (!installed || breathAnimating || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) return;
  const viewTop = window.visualViewport?.offsetTop ?? 0;
  const viewHeight = window.visualViewport?.height ?? window.innerHeight;
  slideBy(centerScrollDelta(rect.top, rect.height, viewTop, viewHeight), ms);
}

/** Center a target after a navigation (e.g. zooming into a childless node).
 *  Deliberate travel, so it uses the fuller pointer ease. */
export function centerAfterNavigation(el: HTMLElement): void {
  requestAnimationFrame(() => centerElement(el, POINTER_SLIDE_MS));
}

/**
 * Center a row after a structural mutation (keyboard move). Two frames so the
 * re-render has committed; the element is looked up THEN, because a move may
 * either reuse the DOM span (focus never leaves, so no focusin fires -- the
 * move-up case) or remount it (focusin already covers it; this re-centers to
 * the same place). Keyboard mutation, so the short beat.
 */
export function centerAfterMutation(getEl: () => HTMLElement | null): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = getEl();
      if (el) centerElement(el, KEYBOARD_SLIDE_MS);
    }),
  );
}

export function installSpotlight(animate = true): void {
  if (installed) return;
  installed = true;
  document.body.classList.add(SPOTLIGHT_ON);
  // Capture phase so the modality is set before focus lands.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("focusin", onFocusIn, true);
  if (!animate) return;
  // Enable (ADR 0060): grow the breathing room and center the lit line as
  // ONE animation. The `pt-[50vh]` class just applied at render; pin the pad
  // back to its pre-toggle value NOW (this runs in a layout effect, before
  // paint, so the class never flashes) and let the tween own the growth. The
  // caret landing (which node gets focus) runs in OutlineEditor's passive
  // effect just after; an off-window first row may still be mounting to
  // claim it, so poll briefly before measuring.
  const region = outlineRegion();
  // Continue from the pad the user is SEEING, never an idealized endpoint. An
  // inline remnant means a breath tween was in flight and just cancelled --
  // mid-flight value wins. Otherwise the pre-toggle steady value: the class
  // just applied at render, so computed padding-top already reads the
  // post-toggle value; the steady base is symmetric with padding-LEFT (the
  // region's padding utilities are uniform: p-6 / max-sm:p-4).
  let padFrom = 0;
  if (region) {
    const live = parseFloat(region.style.paddingTop);
    padFrom =
      Number.isFinite(live) && region.style.paddingTop !== ""
        ? live
        : parseFloat(getComputedStyle(region).paddingLeft) || 0;
    region.style.paddingTop = `${padFrom}px`;
  }
  const grow = () => {
    if (!installed) return;
    const active = document.activeElement;
    const row =
      active instanceof HTMLElement && active.classList.contains("node-text")
        ? (active.closest<HTMLElement>("li[data-node-id], h2.zoomed-title") ??
          active)
        : null;
    let delta = 0;
    if (row) {
      const rect = row.getBoundingClientRect();
      const viewTop = window.visualViewport?.offsetTop ?? 0;
      const viewHeight = window.visualViewport?.height ?? window.innerHeight;
      // Where the row lands once the pad has grown above it -- from where the
      // flight actually starts, not from zero.
      delta =
        rect.top +
        (breathPad() - padFrom) +
        rect.height / 2 -
        (viewTop + viewHeight / 2);
    }
    animateBreath(padFrom, breathPad(), delta);
  };
  const waitClaim = (tries: number) => {
    const active = document.activeElement;
    if (
      (active instanceof HTMLElement &&
        active.classList.contains("node-text")) ||
      tries <= 0
    ) {
      grow();
      return;
    }
    requestAnimationFrame(() => {
      if (installed) waitClaim(tries - 1);
    });
  };
  waitClaim(8);
}

export function uninstallSpotlight(): void {
  if (!installed) return;
  installed = false;
  cancelTween();
  breathAnimating = false;
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("focusin", onFocusIn, true);
  document.body.classList.remove(SPOTLIGHT_ON, SPOTLIGHT_FADE);
  // Disable (ADR 0060): collapse the breathing room as ONE animation. The
  // class just left at render; pin the pad to its current value NOW (layout
  // effect, pre-paint -- no snap) and tween it away. A node still holding
  // focus anchors the view -- the scroll tracks the collapsing pad so the
  // lit line stays glued. No lit line (the usual menu path) means the
  // viewport would be stranded deep in the page, which reads as "lost":
  // collapse and glide to the top in the same motion.
  const active = document.activeElement;
  const held =
    active instanceof HTMLElement && active.classList.contains("node-text");
  const region = outlineRegion();
  const pad = breathPad();
  let base = 0;
  // Continue from the pad the user is SEEING: an inline remnant (a cancelled
  // tween's mid-flight value) wins over the idealized full pad. The steady
  // base must be read with the remnant CLEARED, or it inherits the mid-flight
  // value and the collapse lands off-steady, snapping when the inline clears.
  let flight = pad;
  if (region) {
    const live = parseFloat(region.style.paddingTop);
    if (Number.isFinite(live) && region.style.paddingTop !== "") {
      flight = live;
      region.style.paddingTop = "";
    }
    base = parseFloat(getComputedStyle(region).paddingTop) || 0;
    // Pin the flight pad inline NOW (layout effect, pre-paint) so there is no
    // collapsed frame before the tween's first write.
    region.style.paddingTop = `${flight}px`;
  }
  animateBreath(flight, base, held ? -(flight - base) : -window.scrollY);
}
