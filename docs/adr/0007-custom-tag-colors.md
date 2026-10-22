# Custom tag colors

A `#tag`'s color is **chosen and stored** (not derived from the name), defaulting to a neutral
outline. It lives in a side-collection synced over `/api/kv` (see [ADR 0008: Sync via a per-user Durable Object](./0008-sync-via-a-per-user-durable-object.md)) and is
painted by **one generated stylesheet keyed on `data-tag`** (`TagColorStyles`, mounted once in
`__root.tsx`).

**Why it's not in the code:** the stylesheet indirection looks like overkill until you see the
alternative. A color class per chip would force every bullet containing the tag to **re-decorate**
on a color change — O(instances) React work, and there's no cheap "re-decorate all" signal in the
per-node store. Keying off `data-tag` in one stylesheet makes a recolor an **O(1) DOM write** the
browser applies to all instances for free, with zero React re-renders.

**Don't:** derive colors by hashing the name (noise masquerading as meaning; pre-spends the
palette); put color on `Node` or per-occurrence (it's global to the tag _name_); or use
per-instance classes. The generator skips unsafe tag names (`[\p{L}\p{N}_-]+` guard) — keep that,
it's the CSS-injection guard.
