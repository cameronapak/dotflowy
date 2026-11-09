import { toast } from "sonner";

import { localDateKey } from "./date-links";
import { downloadTextFile } from "./download";
import { flattenInline } from "./inline-text";
import { outlineToMarkdown } from "./markdown";
import { toggleCollapsed } from "./mutations";
import { exportOpml } from "./opml-export";
import { runStructural } from "./structural";
import { childrenOf } from "./tree";
import { getTreeIndex } from "./tree-store";

export async function copyOutlineAsMarkdown(rootId: string | null) {
  const index = getTreeIndex();
  const rootIds = rootId ? [rootId] : childrenOf(index, null).map((n) => n.id);
  const markdown = outlineToMarkdown(index, rootIds);
  if (!markdown) {
    toast("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("Copied as Markdown");
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

export function exportOutlineAsOpml(rootId: string | null) {
  const index = getTreeIndex();
  const root = rootId ? (index.byId.get(rootId) ?? null) : null;
  const rootText = root ? flattenInline(root.text) : "";
  const slug = rootText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const date = localDateKey();
  const filename = slug
    ? `dotflowy-${slug}-${date}.opml`
    : `dotflowy-export-${date}.opml`;
  const opml = exportOpml(index, root ? root.id : null, {
    title: rootText || "dotflowy export",
  });
  downloadTextFile(filename, "text/x-opml;charset=utf-8", opml);
}

/** Browsing stays out of authoring history. Exclude the zoom root so collapsing
 * its children cannot hide the whole view. */
export function setViewCollapsed(rootId: string | null, collapsed: boolean) {
  const index = getTreeIndex();
  const ids: string[] = [];
  const seen = new Set<string>();
  const stack = childrenOf(index, rootId).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const kids = childrenOf(index, id);
    if (kids.length === 0) continue;
    if ((index.byId.get(id)?.collapsed ?? false) !== collapsed) ids.push(id);
    for (const k of kids) stack.push(k.id);
  }
  if (ids.length === 0) {
    toast(collapsed ? "Already collapsed" : "Already expanded");
    return;
  }
  runStructural(() => {
    for (const id of ids) toggleCollapsed(id, collapsed);
  });
}
