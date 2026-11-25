// The personal-plugin definition contract (ADR 0095). A personal plugin is
// DATA: an agent writes a definition over MCP, the Worker validates it and
// stores it in the plugin's own Artifacts repo, and reviewed, compiled-in code
// renders it with Dotflowy's components. No agent-written code runs anywhere.
//
// Unknown keys are rejected, not dropped, so a definition that asks for a
// capability this release does not have (HTML, scripts, a backend, secrets)
// fails loudly instead of saving a silently different plugin.

import { Schema } from "effect";

import {
  COMPONENT_NAME,
  RESERVED_COMPONENT_NAMES,
  TONES,
  type Tone,
} from "./comark";

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Largest stored definition, as JSON. */
export const MAX_DEFINITION_BYTES = 64_000;

const Tone = Schema.Literals(TONES);
const Short = Schema.String.check(Schema.isMaxLength(120));
const Medium = Schema.String.check(Schema.isMaxLength(600));
const Line = (max: number) =>
  Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(/^[^\n]*$/));

// A `/` command's child-bullet template: three levels, 12 per level.
const ChildText = Line(300);
const Child3 = Schema.Struct({ text: ChildText });
const Child2 = Schema.Struct({
  text: ChildText,
  children: Schema.optionalKey(
    Schema.Array(Child3).check(Schema.isMaxLength(12)),
  ),
});
const Child1 = Schema.Struct({
  text: ChildText,
  children: Schema.optionalKey(
    Schema.Array(Child2).check(Schema.isMaxLength(12)),
  ),
});

const Block = Schema.Union([
  Schema.Struct({ type: Schema.Literal("heading"), text: Short }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Medium,
    muted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("list"),
    items: Schema.Array(
      Schema.Struct({
        title: Short,
        subtitle: Schema.optionalKey(Short),
        accessory: Schema.optionalKey(Short),
        tone: Schema.optionalKey(Tone),
      }),
    ).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    type: Schema.Literal("chips"),
    items: Schema.Array(
      Schema.Struct({ label: Short, tone: Schema.optionalKey(Tone) }),
    ).check(Schema.isMaxLength(12)),
  }),
  Schema.Struct({
    type: Schema.Literal("notepad"),
    key: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/)),
    placeholder: Schema.optionalKey(Short),
  }),
]);
const Blocks = Schema.Array(Block).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(12),
);

export const PersonalPluginDefinition = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(PLUGIN_ID)),
  name: Line(60).check(Schema.isMinLength(1)),
  description: Schema.optionalKey(Medium),
  /** A compact band below the page header, always or only on daily notes. */
  subheader: Schema.optionalKey(
    Schema.Struct({
      when: Schema.Literals(["always", "daily-note"]),
      blocks: Blocks,
    }),
  ),
  /** A side panel opened from Cmd+K ("Open <title>"). */
  panel: Schema.optionalKey(Schema.Struct({ title: Short, blocks: Blocks })),
  /** Comark components written in bullet text. */
  components: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isPattern(COMPONENT_NAME)),
        kind: Schema.Literals(["inline", "block"]),
        view: Schema.Literals(["chip", "progress", "board"]),
        tone: Schema.optionalKey(Tone),
        description: Schema.optionalKey(Short),
        /** Block only: the view shows the children, so the outline hides them
         *  until the bullet is zoomed into, where they stay editable. */
        hidesChildren: Schema.optionalKey(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(12)),
  ),
  /** `/` menu commands: text the core inserts, plus optional child bullets. */
  commands: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Short,
        description: Schema.optionalKey(Short),
        insert: Line(300).check(Schema.isMinLength(1)),
        children: Schema.optionalKey(
          Schema.Array(Child1).check(Schema.isMaxLength(12)),
        ),
      }),
    ).check(Schema.isMaxLength(8)),
  ),
});
export type PersonalPluginDefinition = typeof PersonalPluginDefinition.Type;
export type PersonalPluginBlock = typeof Block.Type;
export type PersonalPluginComponent = NonNullable<
  PersonalPluginDefinition["components"]
>[number];
export type CommandChild = typeof Child1.Type;
export type { Tone };

/** The I/O boundary for an agent's definition. Unknown keys are an error. */
export const decodeDefinition = Schema.decodeUnknownEffect(
  PersonalPluginDefinition,
  { onExcessProperty: "error" },
);

/** The rules a schema cannot say, as a plain reason, or null when none fail. */
export function definitionProblem(
  definition: PersonalPluginDefinition,
): string | null {
  if (JSON.stringify(definition).length > MAX_DEFINITION_BYTES)
    return `the definition is over ${MAX_DEFINITION_BYTES} bytes`;
  const names = new Set<string>();
  for (const c of definition.components ?? []) {
    if (RESERVED_COMPONENT_NAMES.has(c.name))
      return `component name "${c.name}" is reserved for Dotflowy`;
    if (names.has(c.name)) return `component "${c.name}" is listed twice`;
    names.add(c.name);
    if (c.kind === "inline" && c.view !== "chip")
      return `inline component "${c.name}" must use view "chip"`;
    if (c.kind === "block" && c.view === "chip")
      return `block component "${c.name}" cannot use view "chip"`;
    if (c.kind === "inline" && c.hidesChildren)
      return `inline component "${c.name}" cannot hide children`;
  }
  const notepads = notepadKeys(definition);
  if (new Set(notepads).size !== notepads.length)
    return "two notepads share a key";
  if (
    !definition.subheader &&
    !definition.panel &&
    !definition.components?.length &&
    !definition.commands?.length
  )
    return "add at least one of components, commands, subheader, or panel";
  return null;
}

/** Every notepad key a definition declares. */
export function notepadKeys(definition: PersonalPluginDefinition): string[] {
  return [
    ...(definition.panel?.blocks ?? []),
    ...(definition.subheader?.blocks ?? []),
  ].flatMap((b) => (b.type === "notepad" ? [b.key] : []));
}

/** What the browser renders: each installed, switched-on plugin's active
 *  definition. */
export interface ActivePersonalPlugin {
  version: string;
  definition: PersonalPluginDefinition;
}

/** GET /api/personal-plugins/state. */
export interface PersonalPluginsState {
  optedIn: boolean;
  plugins: ActivePersonalPlugin[];
}

/** One row in Settings. */
export interface PersonalPluginSummary {
  id: string;
  name: string;
  description: string | null;
  installed: boolean;
  enabled: boolean;
  activeVersion: string | null;
  parts: { syntax: string | null; what: string }[];
}

export interface PersonalPluginVersion {
  version: string;
  note: string;
  createdAt: string;
}
