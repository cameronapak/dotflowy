import { pluginStyles } from "../plugins/registry";

// Mounts every plugin's own CSS (the plugin styles seam) once, so a plugin ships
// its styling in its folder instead of core styles.css. Uses a React 19
// hoisted, deduped <style> (the `href` is the dedupe key, `precedence` hoists it
// to <head> and orders it after the core sheet). Mounted once in __root.tsx,
// next to TagColorStyles -- which stays its own component because it's a
// *dynamic*, data-driven stylesheet (it regenerates as tag colors change),
// whereas this seam carries each plugin's *static* CSS string.
export function PluginStyles() {
  if (!pluginStyles) return null;
  return (
    <style href="dotflowy-plugin-styles" precedence="medium">
      {pluginStyles}
    </style>
  );
}
