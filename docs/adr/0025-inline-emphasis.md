# Inline emphasis as folding tokens

Inline emphasis is parsed from text source, with no schema field or migration. The four styles are bold (`**x**` or `__x__`), italic (`*x*` or `_x_`), strikethrough (`~~x~~`), and Bear-style underline (`~x~`). Commands create canonical asterisk/tilde spellings. Underscore spellings are aliases of the same styles, including toolbar detection and toggle-off. Intraword underscores such as `snake_case_here` stay literal.

## Folding and editing

Emphasis follows the rich-link folding contract ([ADR 0005](./0005-rich-links-source-offset-caret.md)). A folded run is one `contenteditable="false"` atom with its complete text source in `data-src`. When the caret or selection enters the run, its fences become real, dimmed `.md-punct` text outside the styled tag. Revealed interiors can contain their own folded atoms. Source readers and caret helpers use `data-src`, never displayed `textContent`.

This deliberately rejects virtual CSS fence characters and per-edge caret math. Real revealed fences remain editable one character at a time. Folded interiors reveal before a second click can position the caret within them.

Inline code uses the same folding model, with its fences inside the styled code box. Its interior stays literal, even when it contains another format's markers.

## Amendment: mixed formatting

The initial flat-only grammar is superseded by balanced emphasis and recursive interiors. `_THIS **IS** ITALIC_`, `*a **b** c*`, `**a *b* c**`, and shared fences such as `***both***` render their nested styles. Bold/italic/strike/underline can wrap highlights, tags, Bible chips, code, and links. Highlights and revealed spoilers can likewise contain formatted runs. Concealed spoilers remain raw-source opaque bars with no rendered child widgets, so their colors, icons, or interactions cannot leak concealed contents ([ADR 0043](./0043-spoilers-redacted-from-agents.md)).

A regex locates candidate delimiter runs; the pure `emphasisAt` scanner resolves the balanced extent using delimiter flanking, underscore intraword guards, and shared-run disambiguation. Complete code, link, highlight, and spoiler containers shield their own markers while locating an enclosing emphasis close. This is an inline dialect, not a claim of complete CommonMark compliance. Unmatched syntax stays literal.

The registry accepts an optional `TokenSpec.matchEnd` resolver and uses one private combined candidate regex per recursive scan. Emphasis occupies precedence 30, replacing the five flat branches at 30-34. Other precedence values stay unchanged. `TokenView.renderInline` parses strictly smaller interiors with absolute UTF-16 source offsets and propagates selection endpoints. Plugins still return escaped-by-core descriptors, never raw HTML.

Failed scans memoize still-open, opening-only delimiter positions for the current source string, avoiding repeated suffix scans for long runs of unclosed openers. Dual-purpose delimiters depend on their surrounding stack and are retried. The memo retains only one source string and does not change the grammar.

Formatted link labels opt into a formatting-only scan. They support emphasis, code, highlights, and spoilers, but not nested links or interactive tags/Bible/date chips. URLs remain opaque. This avoids competing navigation controls inside an anchor. Revealed-label editing reconstructs source through `readSource`.

## Plain text and interchange

`flattenInline` is the shared reading-text projection for search and display-only titles. It shields literal code before dropping other markup, and recursively strips nested emphasis. Human spoiler interiors remain searchable; the separate MCP redaction boundary remains unchanged.

OPML recursively projects representable formatting, highlights, and link labels, and imports nested formatting rather than flattening it to outermost-wins ([ADR 0037](./0037-opml-import-export.md)). Alias spelling canonicalizes on import; styles are preserved rather than original marker spelling. Code interiors stay literal. Nested highlights and nested anchors remain unrepresentable and are disclosed as import degradations.

Tags and Bible chips retain their compact inline-flex layout, but inherit bold from an enclosing emphasis run. Strike and underline expose `--inline-strike` and `--inline-underline` to those chips, including both decorations together. Normal text-decoration propagation stops at an inline-flex boundary; explicit decoration on the chips keeps them consistent with the surrounding text.

## Guardrails

- Keep revealed fences real text and folded source reconstruction generic.
- Keep code opaque and concealed spoilers free of rendered children.
- Keep nested rendering on smaller slices with absolute offsets.
- Keep toolbar and keymap toggles on the shared marker planner.
- Keep HTML escaping core-owned and interactive children out of formatted link labels.

Regression coverage lives in `emphasis.test.ts`, `inline-text.test.ts`, `inline-wrap.test.ts`, the OPML tests, and the emphasis/mixed-formatting browser journeys.
