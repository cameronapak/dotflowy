import { CornerUpRightIcon } from "lucide-react";
import type { Node } from "../data/tree";
import type { CommandSpec, MenuSpec } from "./types";
import { commandSpecs } from "./registry";

/** The core's own slash commands. Move is structural, not a feature concept. */
export const CORE_COMMANDS: CommandSpec[] = [
  {
    id: "move",
    label: "Move",
    description: "Move under another node",
    icon: CornerUpRightIcon,
    keywords: ["move", "reparent", "under", "into", "relocate", "home"],
    available: () => true,
    run: (id, ctx) => ctx.mutations.onRequestMove(id),
  },
];

/** Plugin commands (Seam C) then core -- preserving the pre-plugin palette order. */
const ALL_COMMANDS: CommandSpec[] = [...commandSpecs, ...CORE_COMMANDS];

function filterCommands(node: Node, query: string): CommandSpec[] {
  const q = query.toLowerCase();
  const available = ALL_COMMANDS.filter((c) => c.available(node));
  if (!q) return available;
  return available.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.includes(q)),
  );
}

/** Seam H: the `/` command palette, composed from Seam C + the core Move command. */
export const coreSlashMenu: MenuSpec = {
  id: "slash-commands",
  trigger: "/",
  openWhenEmpty: true,
  emptyLabel: "No commands",
  entries(trigger, node, ctx) {
    return filterCommands(node, trigger.query).map((cmd) => {
      const Icon = cmd.icon;
      return {
        key: cmd.id,
        render: (active) => (
          <>
            <Icon className="size-4 shrink-0 opacity-70" />
            <span className="flex flex-col">
              <span className="font-medium">{cmd.label}</span>
              <span className="text-muted-foreground text-xs">
                {cmd.description}
              </span>
            </span>
          </>
        ),
        replacement: "",
        after: () => cmd.run(node.id, ctx),
      };
    });
  },
};
