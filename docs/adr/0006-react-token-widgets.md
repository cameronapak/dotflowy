# React token widgets

A Seam-A token can render a **real React component** (return a `WidgetEl` + declare `component`)
instead of a serialized `El` string. The core serializes it to one
`<dotflowy-widget data-src=… contenteditable="false">` atom in the same string hot path, and the
custom element mounts a React root when the browser upgrades it. Consumer: route-bible's chip.

**Why it's not in the code:** the contentEditable's innerHTML is rebuilt imperatively on every
keystroke (see [ADR 0004: Localized rendering via the tree store](./0004-localized-rendering-via-the-tree-store.md)), which would destroy any normal React mount. A **custom
element is the bridge** — it gets re-parsed and re-upgraded on each rebuild, so the *browser* owns
its lifecycle, not React. The core keeps emitting a string.

**Don't:**
- Use a React portal target (gets destroyed by `el.innerHTML = …` → silently never renders).
- Use shadow DOM (a shadow boundary on an inline node inside contentEditable breaks selection).
- Pass live callbacks as props — they cross the boundary as JSON (`data-props`); route interaction
  through Seam B instead.

`El` stays the fast path for plain tokens (code, links, tags); only a token declaring a `component`
pays the React-root cost.
