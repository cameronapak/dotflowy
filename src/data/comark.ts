// Comark component syntax shared by personal plugins (ADR 0095).
//
// Inline: `:name[label]{attrs}`, where `[label]` is required so prose such as
// `Note:that` or `10:30` never reads as a component. Block: a bullet whose text
// starts with `::name{attrs}`; its children are the component's slot. A bullet
// may end with `{tone="green"}` to color itself inside a block view.
//
// Patterns are built from the names an account actually has installed, so an
// unknown name never matches and stays plain text. Stored text is never
// rewritten: export, search, copy, and sync all see the source verbatim.

export const TONES = [
  "neutral",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;
export type Tone = (typeof TONES)[number];
export const isTone = (value: string | true | undefined): value is Tone =>
  TONES.some((tone) => tone === value);

/** A component name: lowercase, starts with a letter, at most 31 characters. */
export const COMPONENT_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Names Dotflowy keeps for its own reviewed components, such as a future
 *  `:verse[John 3:16]` from the Bible plugin. A personal plugin cannot claim
 *  them, so a built-in can adopt the syntax later without a collision. */
export const RESERVED_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  "verse",
  "passage",
  "embed",
  "link",
  "image",
  "code",
  "date",
  "tag",
  "todo",
  "mention",
  "run",
  "app",
]);

const NEVER = "(?!)";

const alternation = (names: readonly string[]) =>
  // COMPONENT_NAME admits only [a-z0-9-], so names need no escaping.
  names.filter((name) => COMPONENT_NAME.test(name)).join("|");

/** Token pattern for `:name[label]{attrs}` limited to `names`. */
export function inlineComponentPattern(names: readonly string[]): string {
  const alt = alternation(names);
  return alt
    ? `(?<![\\p{L}\\p{N}_:]):(?:${alt})\\[[^\\]\\n]*\\](?:\\{[^}\\n]*\\})?`
    : NEVER;
}

/** Token pattern for the leading `::name{attrs}` of a block bullet. */
export function blockComponentPattern(names: readonly string[]): string {
  const alt = alternation(names);
  return alt ? `^::(?:${alt})(?:\\{[^}\\n]*\\})?(?=\\s|$)` : NEVER;
}

const INLINE_PARSE = /^:([a-z][a-z0-9-]*)\[([^\]\n]*)\](?:\{([^}\n]*)\})?$/;
const BLOCK_PARSE = /^::([a-z][a-z0-9-]*)(?:\{([^}\n]*)\})?(?=\s|$)/;
const TRAILING_TONE = /\s\{tone="(neutral|blue|green|yellow|red|purple)"\}\s*$/;

export function parseAttrs(raw: string): Map<string, string | true> {
  const out = new Map<string, string | true>();
  const re = /(?:^|\s)([a-zA-Z][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  for (const m of raw.matchAll(re))
    out.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? true);
  return out;
}

export interface InlineComponent {
  name: string;
  label: string;
  attrs: Map<string, string | true>;
}

/** Parse one whole inline token, or null when it is not one. */
export function parseInlineComponent(token: string): InlineComponent | null {
  const m = INLINE_PARSE.exec(token);
  return m
    ? { name: m[1]!, label: m[2]!, attrs: parseAttrs(m[3] ?? "") }
    : null;
}

export interface BlockComponent {
  name: string;
  attrs: Map<string, string | true>;
  /** The `::name{attrs}` prefix as written. */
  source: string;
  /** The bullet's title after the prefix. */
  title: string;
}

/** The block component a bullet's text starts with, matched by exact name
 *  (`::board` never matches `::board-x`), or null. */
export function parseBlockComponent(text: string): BlockComponent | null {
  const m = BLOCK_PARSE.exec(text);
  return m
    ? {
        name: m[1]!,
        attrs: parseAttrs(m[2] ?? ""),
        source: m[0],
        title: text.slice(m[0].length).trim(),
      }
    : null;
}

/** Split a trailing `{tone="…"}` off a bullet's text. */
export function trailingTone(text: string): {
  label: string;
  tone: Tone | null;
} {
  const m = TRAILING_TONE.exec(text);
  const tone = m?.[1];
  return m && isTone(tone)
    ? { label: text.slice(0, m.index), tone }
    : { label: text, tone: null };
}
