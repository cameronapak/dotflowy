import { useRef } from "react";

import type { AfterPasteInput, PluginContext } from "../types";

import { isMirrorsEnabled } from "../../data/flags";
import { mirrorReplacementReason } from "../../data/mutations";
import { parseNodeLinks } from "../../data/node-links";
import { getTreeIndex, useTreeIndex } from "../../data/tree-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "../kit";
import { useIsProtected } from "../registry";

function NodePasteChoice({
  nodeId,
  targetId,
  text,
  el,
  ctx,
}: {
  nodeId: string;
  targetId: string;
  text: string;
  el: HTMLElement;
  ctx: PluginContext;
}) {
  const first = useRef<HTMLDivElement>(null);
  const tree = useTreeIndex();
  const protectedNode = useIsProtected(nodeId);
  const reason = protectedNode
    ? "This node is protected and can't be replaced by a mirror."
    : mirrorReplacementReason(tree, nodeId, targetId, text);
  const close = () => ctx.openOverlay(null);
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChangeComplete={(open) => {
        if (open) first.current?.focus();
      }}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DropdownMenuContent
        anchor={el}
        className="w-60"
        aria-label="Paste as"
        finalFocus={() => (el.isConnected ? el : false)}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Paste as</DropdownMenuLabel>
          <DropdownMenuItem ref={first} onClick={close}>
            Link to node
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!!reason || !isMirrorsEnabled()}
            title={reason ?? undefined}
            onClick={() => {
              ctx.mutations.onReplaceWithMirror(
                nodeId,
                targetId,
                text,
                el.dataset.historyKey ?? nodeId,
              );
              close();
            }}
          >
            Mirror node
          </DropdownMenuItem>
          {reason && <DropdownMenuLabel>{reason}</DropdownMenuLabel>}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The native link is already saved; dismissing this menu never changes it. */
export function offerNodePasteChoice(
  { before, inserted, text, nodeId, el }: AfterPasteInput,
  ctx: PluginContext,
): boolean {
  if (
    before !== "" ||
    inserted !== text ||
    !el?.closest(".outline-row, .zoomed-title") ||
    !isMirrorsEnabled()
  )
    return false;
  const targetId = parseNodeLinks(text)[0];
  const tree = getTreeIndex();
  const node = tree.byId.get(nodeId);
  if (
    !targetId ||
    text !== `[[${targetId}]] ` ||
    !tree.byId.has(targetId) ||
    !node ||
    node.mirrorOf ||
    tree.childrenByParent.get(nodeId)?.length
  )
    return false;
  ctx.openOverlay(
    <NodePasteChoice
      nodeId={nodeId}
      targetId={targetId}
      text={text}
      el={el}
      ctx={ctx}
    />,
  );
  return true;
}
