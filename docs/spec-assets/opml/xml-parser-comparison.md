# XML parse/serialize approach for OPML import/export

Resolves [#110](https://github.com/cameronapak/dotflowy/issues/110). Method: every candidate was run (Bun, 2026-07-07) against the crafted Workflowy sample (`workflowy-crafted-sample.opml`), two truncated variants, a billion-laughs entity bomb, an XXE probe, and a synthesized 16,882-node / 2.08 MB export matching the real Workflowy export's shape (attribute-heavy, entities inside attributes, ~16% `<time>` spans, `_note` with `&#10;`). Bundle sizes are `bun build --minify --target=browser` + gzip.

## Recommendation

**`@rgrove/parse-xml` (v4, ISC, zero deps) as the one shared parser for both surfaces — browser SPA and Worker MCP path. Serialization is a hand-rolled ~30-line emitter (escape `& < > " '` plus newlines as `&#10;` in attributes); no library.**

## Results

| | crafted sample | truncated input | billion laughs | XXE | 2 MB / 17k nodes | min+gz |
|---|---|---|---|---|---|---|
| **@rgrove/parse-xml** | correct | throws | rejects | rejects | 29 ms | **4 KB** |
| saxes | correct | throws | rejects | rejects | 21 ms | 7 KB |
| @xmldom/xmldom | correct | throws | rejects | rejects | 46 ms | 29 KB |
| fast-xml-parser 5 | **`&#10;` in attributes left undecoded** | throws (with `validate:true` second pass) | inert | rejects | 61 ms | 25 KB |
| htmlparser2 (xmlMode) | correct | **SILENT PARTIAL** (18 rows, no error) | inert | inert | 11 ms | 27 KB |
| txml | **entities never decoded** | **SILENT PARTIAL** | inert | inert | 9 ms | 38 KB |

## Why parse-xml wins

- **Correct on the actual hazard.** Workflowy puts entity-encoded HTML *inside attributes* (`text="&lt;a href=&quot;…&amp;…&quot;&gt;"`) and hard newlines as `&#10;` inside `_note`. parse-xml decodes both exactly. fast-xml-parser leaves `&#10;` literal in attribute values — every multi-line note would import corrupted. That alone disqualifies it.
- **Fails loudly.** A truncated file throws `XmlError` with line/column and a source excerpt — the "no half-tree silent import" requirement, for free. htmlparser2 and txml both returned a partial tree with no error on the same input (the forbidden failure mode).
- **Safe by construction.** It has no DTD entity support at all: internal entity *definitions* are ignored and any non-predefined entity *reference* throws. Billion laughs and XXE both die at the first `&entity;` reference in ~0 ms. A benign `<!DOCTYPE opml>` (no entity use), a leading BOM, CRLF, a missing XML declaration, and CDATA all parse fine.
- **Fast enough.** 29 ms to parse the full 16,882-node export shape. Import cost will live in the DO write path, not parsing.
- **One implementation, both runtimes, unit-testable.** Pure JS, zero deps, no Node/DOM APIs — same code in the SPA bundle and the Worker. That keeps import semantics identical across app UI and MCP (the wire-schema shared-leaf precedent: one leaf both tsconfigs import, so the two surfaces can't drift) and makes the OPML layer pure logic covered by `bun test`, which the repo's testing philosophy wants. 4 KB gzip is the cheapest option measured.

## Rejected alternatives

- **DOMParser in browser + library in Worker**: 0 KB in the SPA, but two implementations of the fidelity-critical path that can (and eventually will) disagree; DOMParser's `<parsererror>`-document error signaling is awkward to type; and the browser half can't be unit-tested under `bun test`. The 4 KB saved isn't worth the drift risk.
- **saxes**: equally strict/safe, slightly faster, but SAX push-style means hand-maintaining the element stack (the harness adapter was ~3× the code), and the project is in maintenance mode. parse-xml's tree API maps 1:1 onto "walk `<outline>` children".
- **fast-xml-parser**: the popular default, but attribute numeric-character-reference decoding is broken for this dialect, validation is a separate second pass (off by default), and it's 6× the bundle.
- **htmlparser2 / txml**: lenient by design — never errors — which is precisely wrong here.
- **@xmldom/xmldom**: correct and strict but 29 KB gz and a history of parsing CVEs; it buys a DOM API the importer doesn't need.
- **Hand-rolled OPML-subset parser**: would need entity decoding, BOM/decl/CDATA handling, and loud-failure positions anyway — that's just reimplementing parse-xml, minus its test suite. (Hand-rolling the *serializer* is fine: escaping is five characters, and OPML output shape is fully under our control.)

## Effect integration sketch

```ts
import { parseXml, XmlError } from "@rgrove/parse-xml"

class OpmlParseError extends Data.TaggedError("OpmlParseError")<{
  message: string
  line?: number   // XmlError carries line/column + excerpt
  column?: number
}> {}

const parseOpml = (raw: string) =>
  Effect.try({
    try: () => parseXml(raw),
    catch: (e) =>
      e instanceof XmlError
        ? new OpmlParseError({ message: e.message, line: e.line, column: e.column })
        : new OpmlParseError({ message: String(e) }),
  })
```

Matches the `worker/wire.ts` convention: malformed user input fails into one typed error → one `catchTag` → 400 (Worker) / toast (app). Guard the raw size *before* parsing (the real export is ~2 MB; a cap around 20 MB is generous) so a pathological upload never reaches the parser.
