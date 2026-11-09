// Quotes (ADR 0079): a node whose text source starts with `> ` reads as a
// quotation. Quote-ness is DERIVED from the text, like emphasis -- not a Kind
// and not a field -- so the marker is what is stored, copied, exported, and read
// by agents. Pure and DOM-free: worker-reachable modules (flattenInline, the
// markdown parser) import it.

/** The marker. The space is required: `>5` and `->` stay literal text. */
export const QUOTE_MARKER = "> ";

/** The marker as a token-regex fragment, anchored to the start of the text.
 *  It folds only when text follows: an empty quote's `> ` is its whole text,
 *  and Chrome cannot hold a caret after a trailing non-editable atom, so the
 *  caret Enter leaves in a carried quote would slide in front of the marker.
 *  An empty quote shows `> ` as plain text instead; it is still a quote. */
export const QUOTE_PATTERN = "^> (?=[\\s\\S])";

export function isQuoteText(text: string): boolean {
  return text.startsWith(QUOTE_MARKER);
}

/** `text` without its leading marker; non-quotes pass through unchanged. */
export function stripQuoteMarker(text: string): string {
  return isQuoteText(text) ? text.slice(QUOTE_MARKER.length) : text;
}

/** Add the marker to plain text, or remove it from a quote. */
export function toggleQuoteMarker(text: string): string {
  return isQuoteText(text) ? stripQuoteMarker(text) : QUOTE_MARKER + text;
}
