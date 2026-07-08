// The plugin registry (ADR 0001 D5). ONE explicit, ordered, greppable array --
// not import.meta.glob auto-discovery. Adding a plugin = add a folder under
// src/plugins/<name>/ and one line here. Array order is the tiebreak when two
// tokens share a precedence, and the order slash commands / keymaps concatenate
// (D7). Dogfooded: code/links/tags are themselves entries, built on the same
// public API, so the core can't grow feature-specific branches.

import code from "./code";
import daily from "./daily";
import emphasis from "./emphasis";
import highlight from "./highlight";
import links from "./links";
import nodeLinks from "./node-links";
import provenance from "./provenance";
import routeBible from "./route-bible";
import tags from "./tags";
import todos from "./todos";
import type { PluginDef } from "./types";

// `provenance` leads: it only contributes a Seam F slot, and
// as the first entry its origin mark renders leftmost — right after the bullet
// dot, ahead of the todos checkbox / daily badge. No tokens/keymap/commands, so
// its array position has no precedence side effects.
export const plugins: PluginDef[] = [
  todos,
  provenance,
  code,
  links,
  nodeLinks,
  routeBible,
  tags,
  emphasis,
  highlight,
  daily,
];
