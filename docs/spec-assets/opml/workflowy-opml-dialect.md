# Workflowy OPML dialect — ground-truth reference

Evidence base (all 2026-07-07, Cam's real Workflowy account):

1. **Crafted sample** exercising every feature — `workflowy-crafted-sample.opml` (this directory), exported via the per-node ••• menu → Export → OPML → Copy.
2. **Full-account export** (private, `~/Downloads/WF - Export - 260707-050434.opml`): 16,882 nodes / 1.95 MB / max depth 10. Census numbers below come from a script over this file.
3. **Live import round-trip test**: the crafted sample was pasted back into Workflowy (paste is the import path), visually verified, re-exported, and diffed — **the re-export was byte-identical to the original file**. So everything documented below is honored on import exactly as emitted on export, and Workflowy's serializer is deterministic.

This doc is the reference for the mapping tickets (#113 notes, #114 inline rich text, #116 export semantics) and the ADR.

## Document shape

```xml
<?xml version="1.0"?>
<opml version="2.0">
  <head>
    <ownerEmail>
      cameronandrewpak@gmail.com
    </ownerEmail>
  </head>
  <body>
    <outline text="..." />
    ...
  </body>
</opml>
```

- `<head>` contains **only** `<ownerEmail>` (whitespace-padded). No `title`, no `dateCreated`, no expansion state — none of the optional OPML-2.0 head elements.
- `<body>` may hold **multiple top-level `<outline>`s** (the full export has 16 — one per top-level bullet; "Export all" does not wrap them in a synthetic root).
- Serializer details (matters only if we want byte-similar output): 2-space indent per depth, self-closing ` />` on leaves, `"` for attribute quotes.

## `<outline>` attributes — the complete set

The full 16,882-node export contains **exactly three** attribute names:

| Attribute | Count | Semantics |
| --- | --- | --- |
| `text` | 16,882 (every node) | The bullet's rich text: escaped inline HTML (below). May be `""` (183 empty bullets). May — rarely — contain a literal newline as `&#10;` (1 occurrence). |
| `_complete` | 1,166 | Present with value `"true"` iff completed; absent otherwise. When present it precedes `text` in attribute order. |
| `_note` | 657 | The bullet's note, as one attribute string. Newlines are `&#10;` (a trailing `&#10;` is included). May contain the same inline HTML as `text` — 62 of 657 real notes carry links/formatting. |

**No identity, no timestamps**: zero occurrences of `_uuid`, `created`, `lm`, or any other attribute. Re-import cannot key on node identity — this is why re-import always duplicates and why the import-UX decision (#111) is always-append.

Aside: Dynalist also uses `_note` (deliberate interop — [Dynalist forum](https://talk.dynalist.io/t/opml-import-export-dynalist-workflowy/750)), so honoring `_note`/`_complete` on import covers more than Workflowy.

## Inline HTML inside `text` / `_note`

Formatting lives as **HTML markup XML-escaped inside the attribute value** (`&lt;b&gt;bold&lt;/b&gt;`). Tag census over the real export:

| Tag | Count | Shape |
| --- | --- | --- |
| `<time>` | 2,683 | Date span (below). ~16% of nodes carry one. |
| `<a>` | 2,349 | `<a href="url">label</a>`. Bare URLs are auto-linked on entry, exporting as `<a href="u">u</a>`. |
| `<mark>` | 214 | Color/highlight (below). |
| `<i>` | 177 | Italic. |
| `<b>` | 137 | Bold. |
| `<code>` | 18 | Inline code. |
| `<u>` | 11 | Underline. |
| `<s>` | 3 | Strikethrough. |
| `<mention>` | 2 | Person mention (below). |

**Nesting is real**: observed shapes include `<b><i>`, `<b><a>`, `<i><mark>`, `<i><a>`, and `<a><mark>…</mark></a>` inside notes. Relevant for #114: dotflowy emphasis is flat (ADR 0025), so nested imports need a defined degradation.

### `<mark>` — text color and highlight

`<mark class="colored c-<name>">` = text color; `<mark class="colored bc-<name>">` = background highlight. Classes observed in the real export: `c-red`, `c-gray`, `bc-teal`, `bc-yellow`, `bc-sky`, `bc-green`, `bc-purple`. (Workflowy's picker offers a fixed palette; parse the `c-`/`bc-` prefix liberally rather than allowlisting names.) Color highlighting has exported this way since a 2021-era update ("Color highlighted text now exports with `<mark>` tags in OPML" — workflowy.com/whats-new).

### `<time>` — date spans

```
<time startYear="2026" startMonth="7" startDay="8">Wed, Jul 8, 2026</time>
<time startYear="2024" startMonth="2" startDay="3" startHour="13">Sat, Feb 3, 2024 at 1:00pm</time>
```

- Structured attributes + human-readable display text. On import Workflowy rebuilds the pill from the **attributes** (round-trip identical); treat the display text as redundant.
- Attribute census: `startYear`/`startMonth`/`startDay` on all 2,683; `startHour` on 2 (display gains "at 1:00pm"; no `startMinute` even for :00). No `end*` attributes appear in this export — Workflowy's date ranges presumably use `endYear` etc., but that variant is **unobserved/unverified**; a liberal parser should accept unknown `start*`/`end*` attrs.
- Frequency matters: at ~16% of real nodes, whatever #114 decides for `<time>` is not an edge case.

### `<mention>` — person mentions

```
<mention id="2544228" by="2544228" ts="130585935"> </mention>
```

Content is a single space; **the display name is not exported**. On import into the *same* workspace, Workflowy re-resolves the id to the name pill (verified live: the pill came back as "@Cameron Pak"). Outside that workspace the id is unresolvable — for dotflowy import there is no recoverable name; degrade explicitly (#114), never silently drop.

### Tags and mirrors

- `#tag` / `@tag` are **plain text** inside `text` — no markup. (They happen to match dotflowy's parsed-from-text tag model directly.)
- **Mirrors export as unmarked plain duplicates** — the mirror and its source are byte-identical `<outline>`s, zero markers, and importing produces two independent nodes. Mirror identity is silently lost by Workflowy itself; nothing for our importer to recover (export-side handling is #116's question).

## Escaping rules

- Standard XML escaping, applied once: `<` → `&lt;`, `&` → `&amp;`, `"` → `&quot;` inside attribute values. `'` stays raw.
- A **user-typed literal `<`** therefore appears double-escaped: `&amp;lt;` (10 occurrences in the real export). After XML-decoding the attribute once, the string still contains `&lt;` entities that are *content*, plus real HTML tags — i.e. **the attribute value is HTML, so it needs an HTML-entity decode after the XML decode**, and the two layers must not be conflated.
- Newline = `&#10;` — the **only** numeric character reference in the entire export (no `&#9;`, no `&#13;`). `@rgrove/parse-xml` decodes these in attribute values correctly (the fast-xml-parser corruption noted on #110).

## Import behavior (what Workflowy accepts)

- **Import = paste.** Pasting an OPML document as text into any bullet parses it into a nested list (the documented path since 2013; verified live). There is no OPML *file*-upload import in the classic flow (the node menu's "Upload file" is attachments).
- The paste handler requires a **trusted clipboard event** — a synthetic `ClipboardEvent('paste')` with `DataTransfer` is ignored (relevant to any future automated e2e against real Workflowy).
- **Everything it exports, it honors on import** — proven by the byte-identical round-trip: `text` inline HTML (all tags above), `_note` incl. `&#10;` newlines and embedded links, `_complete="true"`, deep nesting, emoji/Unicode, `<time>` attrs → live date pill, `<mention>` id → re-resolved pill.
- Constraint on dotflowy's **export** (the destination requires Workflowy-importable output): emit this dialect — escaped inline-HTML `text`, `_note`, `_complete="true"`, `&#10;` newlines. Exact serializer cosmetics (indent, attribute order) are not load-bearing for import.

## Scale profile for the importer (#115)

From the full export: 16,882 nodes, 2,042,162 bytes, depth 10; 657 notes, 1,166 completed, 2,683 time spans, 2 mentions, 183 empty-text bullets, 1 text containing an embedded newline. Parse cost with the chosen parser: ~29 ms (#110).
