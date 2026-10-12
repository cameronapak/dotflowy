import { Fragment } from "react";

import type { Node } from "../data/schema";
import type { PluginContext } from "../plugins/types";

import { usePluginChrome } from "../plugins/registry";

/** Provider bodies stay separate from the editable source link. */
export function NodeBody({
  node,
  position,
  getCtx,
}: {
  node: Node;
  position: "row:body" | "title:body";
  getCtx: () => PluginContext;
}) {
  const { slotsByPosition } = usePluginChrome();
  return (
    <div className="node-body-slot" data-node-body={node.id}>
      {(slotsByPosition.get(position) ?? []).map((slot) => (
        <Fragment key={slot.id}>{slot.render(node, getCtx)}</Fragment>
      ))}
    </div>
  );
}
