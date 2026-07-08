# OPML importer fidelity probe — findings (#118)

Throwaway probe (`fidelity-probe.ts`, this directory — run from a scratch dir with `bun add @rgrove/parse-xml`) over the crafted sample and the full real Workflowy export (16,882 nodes / 1.95 MB). It dry-runs the locked mapping — #113 (`_note` → prepended child bullets) + #114 (inline HTML → dotflowy tokens, using the shipped token patterns byte-for-byte) — and measures what survives.

## Headline findings

1. **"Nothing silently lost" holds on real data.** The content-survival check (every HTML text leaf must appear in the converted output, modulo the two disclosed transforms: mention interiors and sanitized link labels) passes with **zero violations across all 16,882 nodes**.
2. **Scale (feeds #115/#117):** 16,882 → **17,935 post-split nodes (+6.2%)**: 657 notes → 1,052 note bullets (412 blank lines dropped), 1 text-newline split. Depth 10 → 11 (note bullets nest one deeper). One import = ONE `runStructural` batch of ~18k ops → **36 changelog chunks** at ≤500 ops each. Parse: 52 ms. Comfortably inside the 50k app-UI ceiling; 3.6× the 5k MCP ceiling (correctly rejected there).
3. **Degradations are rare and all counted** (~131 constructs, <1% of nodes): 45 styling-inside-link dropped (link wins), 44+11+2 nested formatting dropped (outermost wins), 9 link-wins-over-formatting, 4 empty `<b>`, 2 mentions, 13 gray marks (next item).
4. **Spec divergence found — the #114 color table references ⚪ but the shipped ADR 0035 palette has no white emoji.** `HIGHLIGHT_EMOJI` (src/data/highlight.ts) is exactly 🔴🟠🟡🟢🔵🟣; `==⚪x==` would parse as a *blue* highlight whose text starts with ⚪. The real export has **13 `bc-gray`/`c-gray` marks** that hit this. Probe maps them to bare `==x==` (default blue) and counts. #114's table needs a one-line amendment: gray/brown → bare `==` (not ⚪).
5. **Workflowy's own export contains malformed inline HTML.** 3 unclosed `<b>` + 3 stray `</b>` — bold runs *spanning across bullets* (opened in one node's `text`, closed in a later node's). The importer's HTML scanner must be tolerant by construction: stray close tags ignored, unclosed tags auto-closed at end of value, text always kept. A strict HTML parser would reject real exports.
6. **Accidental tokenization is real but small (rule 2's accepted presentation shift):** 23 nodes carry plain source text that will render as unintended dotflowy tokens on import — 9 italic `*x*`, 9 code `` `x` ``, 4 underline `~x~`, 1 underscore italic. Worth a number in the ADR; not worth an escape layer (as decided).
7. **Dialect doc validated against real bytes:** attribute inventory is exactly `text`/`_complete`/`_note` (zero unknown attributes), tag census matches `workflowy-opml-dialect.md`, `<time>` census is startYear/Month/Day on all 2,683 + startHour on 2, zero `end*`.

## Raw report

## workflowy-crafted-sample.opml

- **bytes:** 2,093 — **parse:** 1 ms
- **nodes:** 21 pre-split → **23 post-split** (1 notes → 2 note bullets, 1 blank lines dropped; 0 text-newline splits)
- **depth:** 7 pre → 7 post — **empty-text bullets:** 0

### <outline> attribute inventory

```
     21  text
      1  _note
      1  _complete
```

### Unknown attributes (loss-report candidates)

```
(none)
```

### Inline HTML tag inventory (text + _note)

```
      3  a
      2  mark
      1  b
      1  i
      1  u
      1  s
      1  code
      1  time
      1  mention
```

### <time> attribute census

```
      1  startYear
      1  startMonth
      1  startDay
```

### Mapping rules applied

```
      3  <a> -> [label](url)
      1  <b> -> **x**
      1  <i> -> *x*
      1  <u> -> ~x~
      1  <s> -> ~~x~~
      1  <code> -> `x`
      1  <time> -> date token (canonical attrs OK)
```

### Degradations (counted + disclosed, per #114)

```
      2  nested <mark> dropped (outermost wins)
      1  <mention> -> @mention(id) (name unrecoverable)
```

### HTML anomalies

```
(none)
```

### Accidental tokenization (plain text that will render as dotflowy tokens)

```
(none)
```

### CONTENT LOSS (must be empty — "nothing silently lost")

**none** ✅

### Sample conversions

- `plain text with special chars &lt; &gt; & &quot; ' and emoji 🙂🚀`
  → `plain text with special chars < > & " ' and emoji 🙂🚀`
- `<b>bold text</b>`
  → `**bold text**`
- `<i>italic text</i>`
  → `*italic text*`
- `<u>underline text</u>`
  → `~underline text~`
- `<s>strikethrough and <mark class="colored c-red">colored</mark> <mark class="colored bc-green">text</mark></s>`
  → `~~strikethrough and colored text~~`
- `<code>inline code text</code>`
  → `ˋinline code textˋ`
- `<a href="https://example.com/path?q=1&r=2">a labeled link</a>`
  → `[a labeled link](https://example.com/path?q=1&r=2)`
- `bare url <a href="https://workflowy.com">https://workflowy.com</a> in text`
  → `bare url [https://workflowy.com](https://workflowy.com) in text`
- `due <time startYear="2026" startMonth="7" startDay="8">Wed, Jul 8, 2026</time> `
  → `due Wed, Jul 8, 2026 `
- `bullet with a multi-line note  ⟨note⟩ note line one with a link <a href="https://example.com/notes?x=1&y=2">https://example.com/notes?x=1&y=2</a>
note line two after a hard newline
`
  → `bullet with a multi-line note  ⟨note-bullets⟩ note line one with a link [https://example.com/notes?x=1&y=2](https://example.com/notes?x=1&y=2) ⏎ note line two after a hard newline`
- `tagged #dotflowy #import-test and a mention <mention id="2544228" by="2544228" ts="130585935"> </mention>  and a tag-style time @work`
  → `tagged #dotflowy #import-test and a mention @mention(2544228)  and a tag-style time @work`

## WF - Export - 260707-050434.opml

- **bytes:** 2,042,162 — **parse:** 42 ms
- **nodes:** 16,882 pre-split → **17,935 post-split** (657 notes → 1052 note bullets, 412 blank lines dropped; 1 text-newline splits)
- **depth:** 10 pre → 11 post — **empty-text bullets:** 183

### <outline> attribute inventory

```
  16882  text
   1166  _complete
    657  _note
```

### Unknown attributes (loss-report candidates)

```
(none)
```

### Inline HTML tag inventory (text + _note)

```
   2683  time
   2349  a
    214  mark
    177  i
    137  b
     18  code
     11  u
      3  s
      2  mention
```

### <time> attribute census

```
   2683  startYear
   2683  startMonth
   2683  startDay
      2  startHour
```

### Mapping rules applied

```
   2683  <time> -> date token (canonical attrs OK)
   2349  <a> -> [label](url)
    162  <i> -> *x*
    129  <b> -> **x**
    122  <mark> -> ==highlight==
     18  <code> -> `x`
     11  <u> -> ~x~
      2  <time> carries startHour
      2  <s> -> ~~x~~
      1  newline in text -> continuation child bullets
```

### Degradations (counted + disclosed, per #114)

```
     45  styling inside <a> dropped (<mark>)
     44  nested <mark> dropped (outermost wins)
     13  <mark gray> -> bare == (spec says ⚪ but shipped palette has no white)
     11  nested <i> dropped (outermost wins)
      4  empty <b> dropped
      4  <i> dropped: contains a link (link wins)
      3  <mark> dropped: contains a link (link wins)
      2  <b> dropped: contains a link (link wins)
      2  <mention> -> @mention(id) (name unrecoverable)
      2  nested <b> dropped (outermost wins)
      1  <s> dropped: contains a link (link wins)
```

### HTML anomalies

```
      3  unclosed <b>
      3  stray </b>
```

### Accidental tokenization (plain text that will render as dotflowy tokens)

```
      9  plain text will tokenize as italic *x*
      9  plain text will tokenize as code `x`
      4  plain text will tokenize as underline ~x~
      1  plain text will tokenize as underscore italic _x_
```

### CONTENT LOSS (must be empty — "nothing silently lost")

**none** ✅

### Sample conversions

- `<time startYear="2018" startMonth="1" startDay="2">Tue, Jan 2, 2018</time>`
  → `Tue, Jan 2, 2018`
- `Event: <a href="https://www.google.com/calendar/event?eid=Nm9zajZwaGg2Z3EzNmI5Z2M0cDNlYjlrY29vM2NiOXA2OHBqOGI5bmNwaG00cDFtNjFpNjZwOWw3NCBjYW1lcm9uYW5kcmV3cGFrQG0">Open in Google Calendar</a>`
  → `Event: [Open in Google Calendar](https://www.google.com/calendar/event?eid=Nm9zajZwaGg2Z3EzNmI5Z2M0cDNlYjlrY29vM2NiOXA2OHBqOGI5bmNwaG00cDFtNjFpNjZwOWw3NCBjYW1lcm9uYW5kcmV3cGFrQG0)`
- `#resource #project  #L  <a href="https://blume.codes/?twclid=2ddqxs14k1fufw4lufzl0wssi2">https://blume.codes/?twclid=2ddqxs14k1fufw4lufzl0wssi2</a>  `
  → `#resource #project  #L  [https://blume.codes/?twclid=2ddqxs14k1fufw4lufzl0wssi2](https://blume.codes/?twclid=2ddqxs14k1fufw4lufzl0wssi2)  `
- `<time startYear="2018" startMonth="1" startDay="3">Wed, Jan 3, 2018</time>`
  → `Wed, Jan 3, 2018`
- `<time startYear="2018" startMonth="1" startDay="5">Fri, Jan 5, 2018</time>`
  → `Fri, Jan 5, 2018`
- `<a href="https://lifechurch.atlassian.net/browse/YPE-1565">📆 Technical Writer Google Internship Out??</a>`
  → `[📆 Technical Writer Google Internship Out??](https://lifechurch.atlassian.net/browse/YPE-1565)`
- `Event: <a href="https://www.google.com/calendar/event?eid=MmIyaGxmcWlvbG9tZ3RhOHRnMHU0ZTQ3ODYgY2FtZXJvbmFuZHJld3Bha0Bt">Open in Google Calendar</a>`
  → `Event: [Open in Google Calendar](https://www.google.com/calendar/event?eid=MmIyaGxmcWlvbG9tZ3RhOHRnMHU0ZTQ3ODYgY2FtZXJvbmFuZHJld3Bha0Bt)`
- `<a href="https://careers.google.com/jobs#!t=jo&jid=/google/technical-writer-intern-summer-2018-601-n-34th-st-seattle-wa-usa-2926220093&">https://careers.google.com/jobs#!t=jo&jid=/google/technical-writer-intern-summer-20`
  → `[https://careers.google.com/jobs#!t=jo&jid=/google/technical-writer-intern-summer-2018-601-n-34th-st-seattle-wa-usa-2926220093&](https://careers.google.com/jobs#!t=jo&jid=/google/technical-writer-intern-summer-2018-601-n`
- `Event: <a href="https://www.google.com/calendar/event?eid=NmtxM2NjOWpjNWgzY2I5a2M4cjY0YjlrNzFqNmNiYjI2Y29tNmJiNTZjcjY0YzMyNmNxMzhwajY2ayBjYW1lcm9uYW5kcmV3cGFrQG0">Open in Google Calendar</a>`
  → `Event: [Open in Google Calendar](https://www.google.com/calendar/event?eid=NmtxM2NjOWpjNWgzY2I5a2M4cjY0YjlrNzFqNmNiYjI2Y29tNmJiNTZjcjY0YzMyNmNxMzhwajY2ayBjYW1lcm9uYW5kcmV3cGFrQG0)`
- `<time startYear="2018" startMonth="1" startDay="7">Sun, Jan 7, 2018</time>`
  → `Sun, Jan 7, 2018`
- `Event: <a href="https://www.google.com/calendar/event?eid=NW1pNGx0amIxMjI3ZGE2czdmc2E5dDQ0Mm8gY2FtZXJvbmFuZHJld3Bha0Bt">Open in Google Calendar</a>`
  → `Event: [Open in Google Calendar](https://www.google.com/calendar/event?eid=NW1pNGx0amIxMjI3ZGE2czdmc2E5dDQ0Mm8gY2FtZXJvbmFuZHJld3Bha0Bt)`
- `* SHOUT: 1 Cor 15:58 -&gt; Do The Work.`
  → `* SHOUT: 1 Cor 15:58 -> Do The Work.`
- `* Get everyone a journal to lead & pens.`
  → `* Get everyone a journal to lead & pens.`
- `* Buy some snacks & refreshments.`
  → `* Buy some snacks & refreshments.`
- `<b>AGENDA</b>`
  → `**AGENDA**`
- `<i>1:45pm - start. Cell phones in the middle. He who grabs his phone, unless an emergency, must twerk in front of the chapter at our first meeting and provide refreshments for everyone there.</i>`
  → `*1:45pm - start. Cell phones in the middle. He who grabs his phone, unless an emergency, must twerk in front of the chapter at our first meeting and provide refreshments for everyone there.*`
- `3. <b>CG Leader Manual. ~ 1 hour.</b>`
  → `3. **CG Leader Manual. ~ 1 hour.**`
- `5. Debrief Time. 15 min. <i>Go for a walk together.</i>`
  → `5. Debrief Time. 15 min. *Go for a walk together.*`



## Rider results

### Multi-frame echo overlay (from #115)

**VERIFIED.** Throwaway Playwright spec (`multi-frame-echo-probe.spec.ts.txt` + `multi-frame-echo-probe.fixtures.patch`, this directory — reverted from the tree after the run): a temporary `echoChunks` option in `seedOutline` splits one structural batch's echo into 3 staggered change frames (consecutive seqs at ~250/500/750 ms), with the POST replying the FINAL seq immediately — the exact shape of #115's chunked `recordChange`. A 3-node indent run asserted at t≈0, mid-echo, and past the final frame: the optimistic overlay held the complete post-batch shape throughout (no partial revert while synced state updated beneath), released onto identical synced state, and a reload confirmed the synced layer converged. **1 passed (8.8s).** The build plan should resurrect this as a permanent regression test alongside the import work.

### Workflowy unknown-attribute tolerance (from #116)

**TOLERATED — no fallback encoding needed.** Pasted an OPML snippet carrying `id`, `_mirror`, and `_task` attributes into live Workflowy (2026-07-07): imported cleanly, content intact, `_complete` honored, unknown attributes silently ignored, no error and no visible artifacts. **But a re-export of the pasted node STRIPS all three custom attributes** (`_complete` survives). Consequence to disclose in the ADR: #116's mirror persistence round-trips dotflowy→dotflowy only; OPML that has passed *through* Workflowy loses mirror identity (and `_task`), so re-import from a Workflowy re-export yields detached duplicates — precisely #116's documented fallback, now verified rather than assumed.
