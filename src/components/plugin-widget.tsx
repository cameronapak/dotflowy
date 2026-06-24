// The plugin WIDGET host (ADR 0028 -- Seam A's React mode). A token can render a
// real React component instead of a serialized `El`. The catch: inline tokens
// live in a contentEditable whose innerHTML the core rebuilds imperatively each
// keystroke (ADR 0014), so React can't own those nodes directly. The bridge is
// ONE custom element, `<dotflowy-widget>`: the core serializes a widget token to
// this element (an opaque atom -- `contenteditable="false"` + `data-src`, ADR
// 0017's caret machinery), and the browser re-upgrades it on every innerHTML
// parse. On connect it mounts a React root rendering the token's component; on
// disconnect it unmounts. So the hot path stays string-based while the chip's
// interior is true TSX (components, lucide icons, Tailwind classes -- no plugin
// CSS).
//
// One generic element, not one per plugin: the registry registers each widget
// token's component here by id (`registerWidget`), and the element dispatches on
// its `data-widget` attribute. Props cross the string boundary as JSON
// (`data-props`); `data-src` carries the source for the caret math and the
// component's `source` prop.

import { createRoot, type Root } from "react-dom/client";
import type { ComponentType } from "react";
import type { Json, WidgetProps } from "../plugins/types";

/** The custom element tag the serializer emits and `customElements.define`s. */
export const WIDGET_TAG = "dotflowy-widget";

// token id -> component. Populated once at load by registry.ts (a plain Map, so
// this module is import-safe in the Node prerender -- only the element define +
// createRoot below are client-gated).
const widgetComponents = new Map<string, ComponentType<WidgetProps>>();

/** Register the component the `<dotflowy-widget data-widget={id}>` atom mounts.
 *  Called by the registry for each token that declares a `component`. */
export function registerWidget(
  id: string,
  component: ComponentType<WidgetProps>,
): void {
  widgetComponents.set(id, component);
}

// Define the element on the CLIENT only. `HTMLElement`/`customElements` don't
// exist in the Node prerender pass (ADR 0004 SPA + the `/` shell prerender), and
// `registry.ts` -- which imports this for `registerWidget` -- is in that pass, so
// the class body (and its `createRoot` call) must never evaluate server-side.
if (
  typeof HTMLElement !== "undefined" &&
  typeof customElements !== "undefined" &&
  !customElements.get(WIDGET_TAG)
) {
  class DotflowyWidget extends HTMLElement {
    private root: Root | null = null;

    connectedCallback() {
      this.mountWidget();
    }

    disconnectedCallback() {
      // Defer the unmount: React forbids unmounting a root synchronously from
      // inside a commit, and innerHTML reassignment can disconnect us mid-flush.
      // Re-check isConnected in the microtask so a same-tick reconnect is a
      // no-op (the browser creates a fresh element per innerHTML parse, so in
      // practice this just tears down the discarded one).
      const root = this.root;
      this.root = null;
      if (root) {
        queueMicrotask(() => {
          if (!this.isConnected) root.unmount();
        });
      }
    }

    private mountWidget() {
      if (this.root) return;
      const id = this.dataset.widget;
      const Comp = id ? widgetComponents.get(id) : undefined;
      if (!Comp) return; // unknown widget id -> render nothing (data-src still serves the caret)
      const source = this.dataset.src ?? "";
      let props: Record<string, Json> = {};
      if (this.dataset.props) {
        try {
          props = JSON.parse(this.dataset.props) as Record<string, Json>;
        } catch {
          props = {};
        }
      }
      this.root = createRoot(this);
      // `source` last so it stays authoritative (a stray `source` in props can't
      // shadow the atom's) and typed `string`, not `Json`.
      this.root.render(<Comp {...props} source={source} />);
    }
  }

  customElements.define(WIDGET_TAG, DotflowyWidget);
}
