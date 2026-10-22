# Plugin global actions and the editor font boundary

Reviewed, compiled-in plugins can contribute node-less `globalActions` to
Cmd+K, including their Settings preferences. These actions remain registered
when optional editor seams are disabled, so the user can turn a feature back
on. Existing preference setters retain readiness, persistence, rollback, and
permission behavior. External-embed consent links to Settings rather than
granting permission through a command.

The appearance seam accepts only `editorFont(): string | null`. Core owns the
font-family property and limits its selector to node text and inline
descendants across rows, zoomed titles, and Quick-add. First non-null font wins
in registry order. This is not the unrestricted plugin CSS retired by ADR 0031:
plugins cannot supply selectors or arbitrary declarations. `chromeChanged`
refreshes action and font snapshots without rebuilding token machinery.

Scribble mode is the first consumer. It uses self-hosted Redacted Script,
including for the active node, without changing text source or spoiler
behavior. It defaults off, persists only in this browser, and toggles through
Cmd+K and the View menu. Its active-only header button turns it off, following ADRs 0033
and 0050. Navigation, controls, images, and embed bodies stay unchanged.
Copy, export, sync, and MCP are unaffected. The font covers Latin and Latin
Extended; unsupported characters can use browser fallback fonts. This is a
writing aid, not a privacy or complete text-obscuring guarantee.
