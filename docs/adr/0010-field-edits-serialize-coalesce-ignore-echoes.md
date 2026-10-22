# Field edits: serialize, coalesce, ignore echoes on the caret

**The symptom.** Typing into a bullet scrambled characters and jumped the caret mid-word — the
outline felt unusable under fast input. (Real report: "characters jumble up while I'm typing.")

**The mechanism.** A field edit is direct (`setText` → `nodesCollection.update` → `onUpdate` →
PATCH), one transaction PER KEYSTROKE, and the bullet is a manually-managed `contentEditable` whose
store-sync effect repaints the DOM whenever `node.text` differs from what it last wrote. The
per-keystroke text path is correct in isolation but exposed to the same two races `runStructural`
closes for structural writes (see [ADR 0009: Atomic structural writes](./0009-atomic-structural-writes.md)) — only here they land on the DOM you're actively typing into:

- **Out-of-order persistence (the field-edit twin of P3).** Each keystroke fires its own PATCH, and
  separate fetches have no ordering guarantee (HTTP/2 muxing, Worker dispatch). `PATCH("ab")` can
  reach the DO _after_ `PATCH("abc")`; last-writer-wins persists the stale `"ab"` and broadcasts it
  as the newest `seq`. The echo overwrites the live row with older text and the `"c"` is lost — and
  it survives refresh. This is genuine data loss, not just a flicker.
- **The overlay/echo gap (the field-edit twin of P2).** A direct `collection.update` overlay drops
  on the PATCH's HTTP ack, which is a _separate_ channel from the WS echo that carries the same text.
  If the ack lands first, the readable value momentarily falls back to the synced base (an older
  echo), the sync effect repaints the focused bullet to that stale text and re-clamps the caret, then
  the echo arrives and it snaps forward. That round trip is the visible scramble.

**The cure — two independent halves, both shipped:**

- **Serialize + coalesce the field PATCH (`api.ts`, `updateNodes`).** Mirrors `persistBatch`'s
  `batchTail`, plus coalescing: while a PATCH is in flight, every later field change MERGES into a
  pending map (field-wise last-write-wins — correct because a PATCH carries only changed columns),
  and when the in-flight request returns the merged latest flushes as ONE ordered PATCH. Order is
  guaranteed (one request at a time), so the out-of-order race is gone. **This is also the cost
  lever:** a burst of N keystrokes costs ~1 Worker+DO round trip per RTT instead of N — a 40-char
  bullet bills a handful of requests, not 40. There is **no artificial debounce latency**: the
  optimistic overlay is already on screen, and we only ever batch what is already in flight.
- **Ignore echo-driven repaints on the focused bullet (`collection.ts` `echoedText` + `OutlineNode`
  store-sync effect).** The sync path records the last server-echoed text per node (`echoedTextFor`).
  While THIS bullet is focused the `contentEditable` is the source of truth, so the effect skips its
  repaint when the incoming `node.text` equals that last echo — i.e. the network reflecting your own
  (possibly stale/out-of-order) keystrokes back. The discriminator works because a LOCAL change
  (undo/redo restore, a slash insert) writes a value that does NOT match the latest echo and so still
  repaints; the echo only matches AFTER the local change has itself echoed. Reconciliation for the
  skipped case resumes on blur (`onBlur` re-reads the DOM).

**This does NOT walk back "field edits must not await an echo."** The overlay still drops on the
PATCH ack (snappy typing, no `waitForSeq`); the focused-bullet guard is what makes the surviving
ack/echo gap harmless, instead of holding the transaction open per keystroke. Field edits stay
_direct_ (they never join `runStructural`) — they are now serialized and coalesced, not made atomic
or echo-held.

**Don't:** send one PATCH per keystroke again ("each field edit is already one frame") — true
per-call, but rapid calls race out of order and bill one DO write per character; debounce the text
PATCH on a timer (adds latency and can lose the last edit on unload — coalescing gets the same
savings with neither); or remove the focused-bullet echo guard ("the store is the source of truth")
— it is, except for the one node whose caret the user owns, where repainting an echo is the scramble.
