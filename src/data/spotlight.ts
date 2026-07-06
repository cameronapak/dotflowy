/**
 * Spotlight focus mode (ADR 0033). When enabled, the outline dims to 0.3 except
 * the *active branch* -- the focused bullet plus its ancestor chain up to the
 * current zoom root -- so the line you're editing and its context stand out.
 *
 * Two halves live here:
 *  1. A tiny localStorage-backed store for the on/off toggle (the More-menu
 *     checkbox reads it via `useSpotlightEnabled`, mirroring show-completed).
 *  2. A framework-agnostic DOM engine that, while enabled, paints the dim with
 *     ONE generated `<style>` keyed on `data-node-id` -- the `TagColorStyles`
 *     mechanism (ADR 0007). Regenerated on each focus change; zero React
 *     re-renders, and it survives the virtualizer's row mount/unmount because a
 *     rule keyed on the id matches a row the instant it scrolls into view.
 *
 * Why a stylesheet and not React state: focus changes on every caret move, so
 * dimming per row in React would re-fight the per-node render budget (ADR 0014).
 * Why the ancestor set is computed in JS: the flat windowed list has no DOM
 * nesting (ADR 0019), so "active + its ancestors" can't be a CSS descendant
 * selector -- we walk the TreeIndex parent chain and emit an explicit id list.
 */

import { getTreeIndex } from "./tree-store";
import { getViewRootId } from "./view-state";
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
const ROW_SELECTOR = "li[data-node-id]";

let styleEl: HTMLStyleElement | null = null;
let installed = false;
// Whether the last interaction was a pointer (vs keyboard). Drives the fade:
// a click into a distant node eases; rapid arrow-nav snaps (ADR 0033).
let lastInputWasPointer = false;

function ensureStyleEl(): HTMLStyleElement {
  if (styleEl) return styleEl;
  styleEl = document.createElement("style");
  styleEl.setAttribute("data-spotlight", "");
  document.head.appendChild(styleEl);
  return styleEl;
}

/**
 * Ids that stay lit for a focused node: the node itself plus every ancestor up
 * to (but not including) the zoom root. The zoom root renders as the page title
 * (`ZoomedTitle`), not an `.outline-row`, so it never dims and needs no rule.
 */
function litIds(nodeId: string): string[] {
  const index = getTreeIndex();
  const stopId = getViewRootId();
  const ids = [nodeId];
  let cur = index.byId.get(nodeId)?.parentId ?? null;
  while (cur && cur !== stopId) {
    ids.push(cur);
    cur = index.byId.get(cur)?.parentId ?? null;
  }
  return ids;
}

function litCss(ids: string[]): string {
  const selectors = ids
    // ids are uuid-shaped; guard the odd case so a stray quote can't break out
    // of the attribute-selector string.
    .filter((id) => !id.includes('"') && !id.includes("\\"))
    .map((id) => `.${SPOTLIGHT_ON} li[data-node-id="${id}"] > .outline-row`)
    .join(",\n");
  return selectors ? `${selectors} { opacity: 1; }` : "";
}

/** The focused outline row's node id, or null if focus isn't in the outline. */
function focusedRowId(): string | null {
  const active = document.activeElement;
  if (!active) return null;
  const li = (active as Element).closest?.(ROW_SELECTOR) ?? null;
  return li?.getAttribute("data-node-id") ?? null;
}

/** Stop dimming: nothing in the outline is focused, so everything is full. */
function clear(): void {
  document.body.classList.remove(SPOTLIGHT_ON, SPOTLIGHT_FADE);
  if (styleEl) styleEl.textContent = "";
}

/** Repaint for whatever is focused right now (called on focus change + install). */
function apply(): void {
  const id = focusedRowId();
  if (!id) {
    clear();
    return;
  }
  ensureStyleEl().textContent = litCss(litIds(id));
  document.body.classList.add(SPOTLIGHT_ON);
  document.body.classList.toggle(SPOTLIGHT_FADE, lastInputWasPointer);
}

const onFocusIn = () => apply();
// Defer past the focus hop so a bullet-to-bullet move (focusout old, focusin
// new) doesn't briefly clear -- by the time this runs, focusin has repainted.
// Same pattern as MobileActionsBar's useOutlineEditing.
const onFocusOut = () => requestAnimationFrame(apply);
const onPointerDown = () => {
  lastInputWasPointer = true;
};
const onKeyDown = () => {
  lastInputWasPointer = false;
};

export function installSpotlight(): void {
  if (installed) return;
  installed = true;
  ensureStyleEl();
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  // Capture phase so we see the input type before focus lands.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  // A bullet may already be focused when the mode is switched on.
  apply();
}

export function uninstallSpotlight(): void {
  if (!installed) return;
  installed = false;
  document.removeEventListener("focusin", onFocusIn);
  document.removeEventListener("focusout", onFocusOut);
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeyDown, true);
  clear();
}
