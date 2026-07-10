---
status: accepted
---

# Spoilers: hidden from humans, redacted from agents

A spoiler -- `||text||` -- is parsed from `node.text` (no schema field, no migration) and rendered as the sixth **folding token**, reusing the emphasis/highlight model ([ADR 0025](./0025-inline-emphasis.md), [ADR 0035](./0035-highlights-color-in-text.md)). `||` is Discord/Telegram's inline-spoiler markup and the de facto standard; pipe shares a leading char with no other token, so it slots in at precedence **40** (after highlight's 35) with no `**`/`*`-style coupling. It is the first token whose meaning is **audience-dependent**: to a human it is _hidden until revealed_; to an AI agent over MCP it is _redacted_. That asymmetry is the whole reason this is an ADR and not a one-line token.

## What it is (and what it is not)

**A context-hygiene default, not access control.** The MCP agent authenticates as the user, routes to the user's own per-user DO, and can already `update_node` any bullet ([ADR 0026](./0026-agent-native-mcp-server.md)) -- it holds the user's keys. So redaction does not keep an untrusted party _out_; it keeps flagged text _out of an LLM's context window by default_. The threat is a plot twist / quiz answer / sensitive note getting pulled into a Claude transcript (cached, maybe logged) when the agent was fetching the outline for something unrelated. The gesture is the same as the human "don't spoil the ending" -- two audiences, one mark.

**This makes the boundary deliberately leaky, and we say so.** The user typed the content and can expose it by editing the node to drop the `||` fences, or by pasting it into chat. The ADR does not pretend the agent "can't see" spoilers -- it _won't be handed_ them by default. The **MCP connector consent copy states this plainly** so a user isn't misled into treating a spoiler as a security guarantee.

## Decisions

**Syntax: `||text||` (Discord).** Rejected Reddit's `>!text!<` (asymmetric, uglier, lower recognition, Reddit-only) and `<details>`/`<summary>` (block-level, and raw HTML breaks the plain-text data model -- the same reason ADR 0035 rejected `<mark style>`). `||spoiler||` pasted into Discord _is_ a spoiler -- the "self-describing when pasted anywhere" principle (ADR 0035). Discord's "negated by a code block" rule falls out for free: `code` is a folding token at precedence 10 that shields its interior, so `` `||x||` `` stays literal.

**Redaction marks, it does not omit.** At every MCP egress a spoiler becomes the fixed sentinel `[spoiler]` -- interior-length-independent (don't leak the character count either). A visible `[spoiler]` lets the agent be useful about it ("there's a spoiler here I can't read -- paste it if you want me to see it") and stops it hallucinating across a silent gap. Omission (the run just vanishes) was rejected for both reasons.

**Search cannot match inside a spoiler.** `search_nodes` strips spoiler interiors _before_ the substring match, not just before the output. A term that appears only inside a spoiler yields **zero hits** -- otherwise an agent probes: search `killer` -> a hit reveals the killer's name lives in that node even while the text is masked. The spoiler is invisible to agent search, not merely masked in the result.

**The egress line: redact everything crossing the MCP/LLM boundary; leave human egress verbatim.**

| Egress                                                        | Audience                             | Redacted                               |
| ------------------------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `get_outline` (MCP)                                           | LLM context                          | yes                                    |
| `search_nodes` (MCP)                                          | LLM context                          | yes (and cannot match inside -- above) |
| `export_opml` (MCP tool)                                      | LLM context (the agent asked for it) | yes                                    |
| In-app markdown copy ([ADR 0017](./0017-markdown-export.md))  | the user's clipboard                 | no                                     |
| In-app OPML export ([ADR 0037](./0037-opml-import-export.md)) | the user's backup file               | no                                     |

One `redactSpoilers(text)` is applied to **every** text value the MCP server emits -- node text, search snippets, **and** ancestor `path`/breadcrumb trails (an ancestor bullet can hold a spoiler). A human-triggered backup that silently dropped content would be a broken backup, so in-app copy/export keep the raw `||...||`.

**Two pure functions, opposite operations on the same token.** The in-app flatten chain (`flattenInline`, feeding Cmd+K corpus / breadcrumbs / in-app search) _strips_ -- fences off, **interior kept** -- because the user's own search must find text inside the user's own spoilers. The MCP boundary _redacts_ -- whole token to `[spoiler]`, interior gone. So:

- `stripSpoilers(text)` -> `flattenInline` (in-app; interior visible to you).
- `redactSpoilers(text)` -> MCP serialization only (interior never leaves).

Both live in a dependency-free `src/data/spoiler.ts` (the `highlight.ts` / `date-links.ts` shape, `bun test`-clean), imported by the Worker via the cross-tsconfig pattern ([ADR 0014](./0014-validate-the-worker-do-trust-boundary.md)) so client and Worker can't drift.

**No agent reveal path in v1.** A `reveal: true` param was rejected as near-incoherent: an agent-settable flag defeats the feature (the agent just always sets it), and stateless MCP has no interactive-consent step to gate a _user_-approved reveal on. The two in-the-loop escape hatches (edit the node, paste into chat) are deliberate human actions -- exactly the property wanted. If real usage demands it, the shape is an OAuth consent screen (ADR 0026's `consentPage` note), not a tool argument.

**Editor rendering: an opaque bar, revealed purely by caret.** At rest the run folds to one atom `<span data-src="||text||">` skinned as a **solid opaque bar** (rejected blur -- it bleeds at the edges and reads less deliberate). Reveal is the **existing folding-token caret mechanic, unchanged**: the atom is `contenteditable="false"`, so clicking it lands the caret adjacent and caret-proximity unfolds the run to `||interior||` with dimmed `.md-punct` fences _inside_ the bar (the inline-code fence-in-container model); move the caret out and it re-folds. **One action, no click-toggle, no separate re-hide gesture** -- so a spoiler needs **no Seam B**. It differs from a highlight only in the at-rest skin and the redaction.

**Creation: the shared wrap path, three entries.** `/spoiler` (Seam C), `Mod+Shift+S` (Seam D -- free; emphasis owns `Mod+Shift+X`, highlight `Mod+Shift+H`), and an **`Eye`** button in the desktop selection formatting toolbar ([ADR 0036](./0036-desktop-selection-formatting-toolbar.md)), all through `toggleWrapSelection` (`src/components/wrap.ts`). Unlike highlight and link (special-cased in that toolbar), `||` is a plain marker toggle, so it drops straight into the clean `detectMarkerWrap`/`planMarkerToggle` path; the button lights when the selection sits inside a spoiler.

## Consequences

- **Write-back drops the spoiler, by design.** `update_node` takes a whole new text string. An agent that reads a spoiler-bearing node (gets `... [spoiler]`) and rewrites it writes the _redacted_ text back -- the real interior is destroyed. This is inherent to read-redaction + blind rewrite; you cannot hide content _and_ let a blind agent rewrite the node losslessly. **Accepted for v1 and documented loudly**: the `update_node` tool description warns that spoiler content is redacted and editing a spoiler-bearing node drops the spoiler. Round-trip preservation (the DO remembering the original and splicing it back) is real machinery deferred until someone hits it -- consistent with the leaky-but-honest framing.
- New plugin `src/plugins/spoiler/` (Seams A + C + D + the ADR 0036 toolbar button); new pure module `src/data/spoiler.ts`; `flattenInline` gains `stripSpoilers`; `worker/outline-ops.ts` applies `redactSpoilers` at every serialization point (`flattenSubtree` text, `searchNodes` text/path/match, the OPML tool). The MCP connector consent copy gains the honesty note.
- No `Node` field, no migration, no wire-schema change -- a spoiler is text.

## Rejected

- **A Node field / node-level spoiler.** Inline-only; a whole-bullet spoiler is a bullet that is one spoiler token, and hiding a subtree is node collapse. Nothing to add to the schema.
- **Blur skin, click-to-toggle reveal, omission redaction, agent `reveal` flag, redacting in-app copy/export** -- each above.
