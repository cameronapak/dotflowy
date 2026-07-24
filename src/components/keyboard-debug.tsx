/**
 * TEMPORARY diagnostic scaffolding. Delete this file, its flag
 * (`isKeyboardDebugEnabled`), and its mount in `OutlineEditor` once the ADR 0030
 * keyboard-anchored bar's positioning is fixed.
 *
 * Why it exists: the mobile actions bar dropped behind the software keyboard when
 * you edited a bullet at the bottom of the page, and the shipped lift formula
 * (`innerHeight - (vv.height + vv.offsetTop)`) was provably correct for the
 * coordinate model we THOUGHT we were in. It printed the numbers that showed the
 * model was wrong on real hardware: on one iPhone, one keyboard session,
 * `innerHeight` read 526, `clientHeight` 498, and the true pre-keyboard band
 * bottom 590 — three different answers. Positioning now rides the
 * VirtualKeyboard API's inset (`--kb-inset`, see data/keyboard-inset.ts), and
 * this readout is what confirms that inset is committing sane values on a given
 * device.
 *
 * Two design constraints, both load-bearing:
 *
 * 1. **It must not share the bar's positioning.** The bar is bottom-anchored and
 *    lifted by a computed offset; if that offset is the bug, a readout riding
 *    the same anchor goes off-screen with it and tells us nothing. So this is
 *    TOP-anchored and translated by `visualViewport.offsetTop` alone — the one
 *    number that places an element in the visible band without touching
 *    `innerHeight`. If the readout itself lands wrong, that IS the finding.
 * 2. **It measures the bar rather than reading its props.** `[data-mobile-bar]`
 *    is queried each frame for its real `getBoundingClientRect()`, so we learn
 *    where the bar actually went, not where we asked it to go.
 *
 * The update loop is a plain unconditional rAF, not the event-coalesced pattern
 * of the real hook: iOS commits keyboard geometry across an animation, and a
 * debug tool that samples on the same events as the code under test can miss
 * exactly the frame that misbehaves.
 */

import { useEffect, useRef, useState } from "react";

import { isKeyboardDebugEnabled } from "../data/flags";

interface Sample {
  /** `window.innerHeight` — the term the old, broken formula trusted. */
  innerH: number;
  /** `documentElement.clientHeight` — the layout viewport `bottom:0` resolves against. */
  clientH: number;
  vvH: number;
  vvTop: number;
  vvPageTop: number;
  scale: number;
  scrollY: number;
  /** Today's lift: `innerH - (vvH + vvTop)`, unclamped so a negative shows. */
  gap: number;
  /** `vv.height + vv.offsetTop` captured at focusin, before the keyboard animates. */
  baseline: number | null;
  /** The polyfill's SPEC rule 2: `max(0, baseline - vvH - vvTop)`. */
  remainder: number | null;
  /** The polyfill's SPEC rule 2 trueHeight: `max(0, baselineH - vvH)`. */
  trueHeight: number | null;
  /** Measured `[data-mobile-bar]` edges in client coords, or null when unmounted. */
  barTop: number | null;
  barBottom: number | null;
  /** The live `--kb-inset` — the lift the bar is actually using. */
  vkInset: string;
  /** Where the measured anchor probe reports `bottom: 0` landing. The lift is
   *  this minus `vv.height`, so `probeBottom - vvH` should equal `vkInset`. */
  probeBottom: number;
}

function readSample(
  baseline: { bottom: number; height: number } | null,
): Sample {
  const vv = window.visualViewport;
  const vvH = vv?.height ?? window.innerHeight;
  const vvTop = vv?.offsetTop ?? 0;
  const bar = document.querySelector("[data-mobile-bar]");
  const rect = bar?.getBoundingClientRect() ?? null;
  return {
    innerH: window.innerHeight,
    clientH: document.documentElement.clientHeight,
    vvH: Math.round(vvH),
    vvTop: Math.round(vvTop),
    vvPageTop: Math.round(vv?.pageTop ?? 0),
    scale: vv?.scale ?? 1,
    scrollY: Math.round(window.scrollY),
    gap: Math.round(window.innerHeight - (vvH + vvTop)),
    baseline: baseline ? Math.round(baseline.bottom) : null,
    remainder: baseline
      ? Math.max(0, Math.round(baseline.bottom - vvH - vvTop))
      : null,
    trueHeight: baseline
      ? Math.max(0, Math.round(baseline.height - vvH))
      : null,
    barTop: rect ? Math.round(rect.top) : null,
    barBottom: rect ? Math.round(rect.bottom) : null,
    vkInset:
      document.documentElement.style.getPropertyValue("--kb-inset") ||
      "(unset)",
    probeBottom: Math.round(
      (
        document.querySelector("[data-kb-probe]") ?? document.body
      ).getBoundingClientRect().bottom,
    ),
  };
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="opacity-60">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Live viewport-geometry readout, top-anchored to the visual viewport. Renders
 * nothing unless `?kbdebug=on` has been visited on this device.
 */
export function KeyboardDebugOverlay() {
  // Read the flag once: it writes to localStorage, and re-running it every
  // render would re-persist on every commit for no benefit.
  const [enabled] = useState(isKeyboardDebugEnabled);
  const [sample, setSample] = useState<Sample | null>(null);
  // The per-focus baseline the polyfill's SPEC rule 2 describes: captured on
  // focusin BEFORE the keyboard animates, held across editable-to-editable
  // focus, cleared on focusout. A ref, not state — it must not drive renders.
  const baseline = useRef<{ bottom: number; height: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const captureBaseline = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      // Held across editable-to-editable focus: only the first focusin of a
      // keyboard session sees a pre-keyboard viewport, so re-capturing on the
      // second bullet would bake the shrunk height in as the baseline.
      if (baseline.current) return;
      baseline.current = {
        bottom: vv.height + vv.offsetTop,
        height: vv.height,
      };
    };
    const clearBaseline = () => {
      // focusout fires before the next focusin when hopping bullets, so defer
      // the clear a frame and let a refocus keep the baseline alive.
      requestAnimationFrame(() => {
        const el = document.activeElement;
        const stillEditing = el instanceof HTMLElement && el.isContentEditable;
        if (!stillEditing) baseline.current = null;
      });
    };

    let raf = 0;
    const tick = () => {
      setSample(readSample(baseline.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    document.addEventListener("focusin", captureBaseline);
    document.addEventListener("focusout", clearBaseline);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("focusin", captureBaseline);
      document.removeEventListener("focusout", clearBaseline);
    };
  }, [enabled]);

  if (!enabled || !sample) return null;

  return (
    <div
      // Top-anchored and translated by offsetTop ALONE — see the file doc. z-50
      // clears the bar's z-40; pointer-events-none so it can never eat a tap.
      className="pointer-events-none fixed inset-x-2 top-0 z-50 rounded-lg bg-black/85 px-2.5 py-2 font-mono text-[10px] leading-tight text-white"
      style={{ transform: `translateY(${sample.vvTop}px)` }}
    >
      <Row
        label="innerH / clientH"
        value={`${sample.innerH} / ${sample.clientH}`}
      />
      <Row
        label="vv h / top / page"
        value={`${sample.vvH} / ${sample.vvTop} / ${sample.vvPageTop}`}
      />
      <Row
        label="scale / scrollY"
        value={`${sample.scale.toFixed(2)} / ${sample.scrollY}`}
      />
      <Row
        label="probe / lift"
        value={`${sample.probeBottom} / ${sample.vkInset}`}
      />
      <Row label="gap (old formula)" value={sample.gap} />
      <Row label="baseline" value={sample.baseline ?? "-"} />
      <Row
        label="remainder / true"
        value={`${sample.remainder ?? "-"} / ${sample.trueHeight ?? "-"}`}
      />
      <Row
        label="bar top / bottom"
        value={
          sample.barTop === null
            ? "unmounted"
            : `${sample.barTop} / ${sample.barBottom}`
        }
      />
    </div>
  );
}
