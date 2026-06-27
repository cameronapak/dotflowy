// The plugin registry (ADR 0018 D5). ONE explicit, ordered, greppable array --
// not import.meta.glob auto-discovery. Adding a plugin = add a folder under
// src/plugins/<name>/ and one line here. Array order is the tiebreak when two
// tokens share a precedence, and the order slash commands / keymaps concatenate
// (D7). Dogfooded: code/links/tags are themselves entries, built on the same
// public API, so the core can't grow feature-specific branches.

import code from "./code";
import daily from "./daily";
import links from "./links";
import routeBible from "./route-bible";
import tags from "./tags";
import themes from "./themes";
import todos from "./todos";
import type { PluginDef } from "./types";

export const plugins: PluginDef[] = [
  code,
  links,
  routeBible,
  tags,
  todos,
  daily,
  themes,
];
