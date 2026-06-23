// Code plugin (ADR 0018). The inline `code` run -- `` `like this` `` -- as a
// token plugin. Source == display (backticks stay visible), so it never folds.
// This is the simplest dogfood of Seam A: pattern + render, no interaction.

import { definePlugin, type El } from "../types";

// Single-line, non-empty, no nested backtick.
const CODE_RUN = "`[^`\\n]+`";

const CODE_CLASS =
  "rounded-[4px] border border-border/60 bg-muted px-0.5 py-0.5 font-mono text-[0.85em] text-foreground";

function codeEl(tok: string): El {
  return { tag: "code", attrs: { class: CODE_CLASS }, children: [tok] };
}

export default definePlugin({
  id: "code",
  tokens: [
    {
      id: "code-run",
      pattern: CODE_RUN,
      // Between links (0) and tags (20): a `#tag` inside a code run stays code.
      precedence: 10,
      render: (tok) => codeEl(tok),
    },
  ],
});
