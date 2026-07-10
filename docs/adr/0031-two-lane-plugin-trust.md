# Two-lane plugin trust: compiled-in draws nodes, sandboxed draws panels

Status: accepted

Plugins split into **two lanes by trust gate, not by author identity.** **Lane A** is
code that passed review and is **compiled into the bundle** (today's only model —
[ADR 0001](./0001-plugin-architecture.md)); it earns **full node privileges**. **Lane B**
is untrusted runtime code no one reviewed; it enters _only_ as an iframe-sandboxed
**MCP App** (extending the MCP server — [ADR 0026](./0026-agent-native-mcp-server.md)) and
renders **only in summoned panels/overlays, never on the outline surface.** This answers
the runtime-extension question ADR 0001 deferred: we **adopt** a sandbox (the MCP Apps
iframe) instead of **building** the "module loader + sandbox + capability model this
project doesn't need."

**The keystone: nodes render trusted-compiled-in code only.** The outline _is_ the
product; it must be impossible for unreviewed code to draw a bullet. Lane B is quarantined
to panels precisely so this holds. This single rule is what lets us promise the main
experience can never be uglified or made unsafe by a third party — the surface is 100%
Lane A, and everything untrusted sits behind a boundary the user opens on purpose.

**"First-party" means vetted-and-compiled-in, not authored-by-us.** A partner company's
plugin merged through review is Lane A with full node rights; that same company's MCP
server is Lane B. **The gate is the PR, not the logo.**

## Seams this changes (grounded against current code)

- **Node decorations stop being free `ReactNode`.** Seam-F row/title slots (`SlotSpec`,
  `registry.ts`) plus a new trailing decoration zone gain a **core-enforced, CSS-only space
  budget**; anything past it collapses to an overflow affordance that opens a panel. **Any
  shadcn component is allowed (tokens-only)** — freedom is capped by _space_, not
  _vocabulary_. The budget MUST be CSS-only (`max-width`/`overflow`, no per-render
  measurement) because the row is on the virtualized hot path
  ([ADR 0019](./0019-virtualized-outline-rendering.md),
  [ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)).
- **Raw global CSS is retired.** `PluginDef.styles` (`registry.ts:47`, currently
  unsanitized and un-namespaced) is scoped or removed. Sole current consumer is `emphasis`
  (`src/plugins/emphasis/index.tsx:152`), so the migration is near-zero.
- **`openOverlay` gains a persistent panel host** (the Tier-3 seam) — the successor for
  rich, contained UI; the unused `src/components/ui/sheet.tsx` is the primitive. First
  consumers: node-overflow detail and the Bible side panel. This panel host is **also the
  only place Lane B may render.**
- **Inline-text tokens are explicitly carved out.** Links/code/tags/emphasis/route-bible
  render as serialized atoms inside contentEditable (`El`/`WidgetEl` —
  [ADR 0006](./0006-react-token-widgets.md)), not React trees, so they **cannot** use
  shadcn and keep their existing constrained builder. This is already the tightest seam;
  leave it alone. (Don't let anyone jam a `<Button>` into a `#tag`.)
- **The MCP server grows a UI surface for Lane B** — **deferred and gated.** The MCP-UI /
  Apps spec's maturity, and whether host theme tokens can be fed into the sandboxed iframe,
  are both unverified. No Lane-B work starts until those close.

## Considered and rejected

- **A first-party module loader + JS sandbox for untrusted plugins** (ADR 0001's deferral,
  taken literally). Rejected: MCP Apps gives us an iframe sandbox _and_ a
  distribution/transport model for free; hand-rolling a capability system re-invents a spec
  at a quarter's cost.
- **Let (vetted) third parties decorate nodes directly.** Rejected as the default — it puts
  the anti-ugly/anti-unsafe guarantee at the mercy of a per-node sandbox. A partner who
  needs node decorations takes Lane A (review + compile-in), which already grants them.
- **Restrict the node component vocabulary (Raycast-style fixed primitives).** Rejected: it
  limits authors we trust, and "trust shadcn" is a _per-component_ guarantee, not
  _per-composition_. Capping _space_ prevents the busy-row failure without shrinking the
  palette.

## Consequences

- The anti-ugly guarantee is **asymmetric, by design**: hard/architectural for Lane A
  nodes; contained-not-restrained for Lane B panels (a sandboxed MCP App can look off-brand
  inside its own frame — it just cannot leak).
- The **panel host is net-new surface** and the largest build downstream of this ADR.
- **Two open items gate Lane B:** MCP Apps spec maturity, and theme-token feeding into the
  iframe. Until both are verified, Lane B stays a design, not a build.
