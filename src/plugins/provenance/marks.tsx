// The logo each source app shows on the nodes it created (ADR 0081). Keyed by
// the shared SOURCE_APPS list, so adding an app there without a logo here is a
// type error. Simple Icons covers most apps; the rest use each brand's own
// published file (brand-marks.ts). Anything unlisted gets the bot.

import type { ComponentType } from "react";

import {
  SiAnthropic,
  SiClaude,
  SiCline,
  SiCursor,
  SiGithubcopilot,
  SiGooglegemini,
  SiMistralai,
  SiOpencode,
  SiPerplexity,
  SiRaycast,
  SiWindsurf,
  SiZedindustries,
} from "@icons-pack/react-simple-icons";

import { BotIcon, SparklesIcon, TerminalIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

import { knownSourceApp, type SourceApp } from "../../data/source-apps";
import { BRAND_MARKS, type BrandMark } from "./brand-marks";

type Glyph = ComponentType<{
  className?: string;
  title?: string;
  "aria-hidden"?: true;
}>;

type Mark = (
  | { icon: Glyph; brand?: never }
  | { brand: keyof typeof BRAND_MARKS; icon?: never }
) & {
  /** Hugeicons stroke icons carry their own padding, so they draw full-size. */
  stroke?: true;
  /** OpenAI and xAI allow their marks only in black or white ("use the logo
   *  exactly as provided"), so these take the text color, not the muted one. */
  fullTone?: true;
  /** Amp's only mark is its wordmark, about 2.3 times wider than tall. */
  wide?: true;
};

const MARKS = {
  Claude: { icon: SiClaude },
  "Claude Code": { icon: SiAnthropic },
  ChatGPT: { brand: "openai", fullTone: true },
  Codex: { brand: "openai", fullTone: true },
  Gemini: { icon: SiGooglegemini },
  "Gemini CLI": { icon: SiGooglegemini },
  Grok: { brand: "grok", fullTone: true },
  Cursor: { icon: SiCursor },
  "GitHub Copilot": { icon: SiGithubcopilot },
  Windsurf: { icon: SiWindsurf },
  Zed: { icon: SiZedindustries },
  Cline: { icon: SiCline },
  OpenCode: { icon: SiOpencode },
  Amp: { brand: "amp", wide: true },
  Devin: { brand: "devin" },
  Poke: { brand: "poke" },
  Muse: { brand: "muse" },
  "Muse Code": { brand: "muse" },
  Perplexity: { icon: SiPerplexity },
  Raycast: { icon: SiRaycast },
  "Le Chat": { icon: SiMistralai },
  "Dotflowy CLI": { icon: TerminalIcon, stroke: true },
} satisfies Record<SourceApp, Mark>;

/** Unlisted apps, and nodes stamped before ADR 0081 with an OAuth client name
 *  no listed app matches ("agent", "MCP Inspector"). */
const FALLBACK: Mark = { icon: BotIcon, stroke: true };

const GENERIC_AI_MARK: Mark = { icon: SparklesIcon, stroke: true };

export function markFor(origin: string, showAppIcons: boolean): Mark {
  if (!showAppIcons) return GENERIC_AI_MARK;
  const app = knownSourceApp(origin);
  return app ? MARKS[app] : FALLBACK;
}

/** The glyph alone, sized for its home: 16px in a row, 20px in a title. */
export function SourceAppGlyph({
  mark,
  placement,
}: {
  mark: Mark;
  placement: "row" | "title";
}) {
  const row = placement === "row";
  const className = cn(
    mark.wide
      ? row
        ? "h-2.5 w-auto"
        : "h-3 w-auto"
      : mark.stroke
        ? row
          ? "size-4"
          : "size-5"
        : row
          ? "size-3.5"
          : "size-4",
  );
  if (mark.icon) {
    const Icon = mark.icon;
    // Simple Icons render a <title> the browser would show as a second,
    // native tooltip over ours; an empty one suppresses it.
    return mark.stroke ? (
      <Icon className={className} aria-hidden />
    ) : (
      <Icon className={className} title="" aria-hidden />
    );
  }
  const brand: BrandMark = BRAND_MARKS[mark.brand];
  return (
    <svg
      viewBox={brand.viewBox}
      fill="currentColor"
      className={className}
      aria-hidden
    >
      {brand.paths.map((p) => (
        <path key={p.d} d={p.d} transform={p.transform} />
      ))}
    </svg>
  );
}
