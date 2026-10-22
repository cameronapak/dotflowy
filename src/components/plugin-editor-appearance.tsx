import { useLayoutEffect } from "react";

import { usePluginChrome } from "../plugins/registry";

/** The host owns the selector and property. Plugins supply only a font family. */
export function PluginEditorAppearance() {
  const { editorFont } = usePluginChrome();
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (editorFont) {
      root.style.setProperty("--plugin-editor-font", editorFont);
      root.setAttribute("data-plugin-editor-font", "");
    }
    return () => {
      root.style.removeProperty("--plugin-editor-font");
      root.removeAttribute("data-plugin-editor-font");
    };
  }, [editorFont]);
  return null;
}
