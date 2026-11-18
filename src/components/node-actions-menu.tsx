import { Menu } from "@base-ui/react/menu";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { MoreIcon } from "@/lib/icons";

import type { CommandCenterAction } from "../data/command-center-types";

import { getNodeActionBridge } from "../data/command-bridge";
import { buildNodeActions } from "../data/command-center";
import { getTreeIndex } from "../data/tree-store";
import { instanceIdForKey } from "../data/visible-order";
import { MenuSheetContent } from "./menu-sheet";
import { Kbd, KbdGroup } from "./ui/kbd";

/**
 * The bullet actions menu (issue #192). One menu per editor; a row's More
 * button, the mobile actions bar, and Mod+Shift+. open it for one row KEY.
 * Its rows are the Cmd+K "Acting on" actions (ADR 0034), so the two surfaces
 * share one action list. Wide screens anchor a Base UI menu to the trigger;
 * below 768px it is a Liquidglass sheet (ADR 0066).
 */
interface Request {
  /** The row key: mirror instances keep their own address (ADR 0022). */
  key: string;
  anchor: HTMLElement | null;
  /** Whether the opening gesture came from the keyboard (enter the menu). */
  keyboard: boolean;
  /** Where focus goes when the menu closes without running an action. */
  returnFocus: HTMLElement | null;
}

let opener: ((request: Request) => void) | null = null;

const DELETE_ID = "node:delete";

export function openNodeActionsMenu(request: Request) {
  opener?.(request);
}

/** The More button OutlineRow renders. Pointer opens keep the caret where it is. */
export function NodeActionsButton({
  rowKey,
  label,
}: {
  rowKey: string;
  label: string;
}) {
  return (
    <button
      type="button"
      className="node-actions-trigger"
      aria-label={`More actions for ${label}`}
      aria-haspopup="menu"
      aria-expanded="false"
      aria-keyshortcuts="Meta+Shift+Period Control+Shift+Period"
      title="More actions (⌘⇧.)"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const focused = document.activeElement;
        openNodeActionsMenu({
          key: rowKey,
          anchor: e.currentTarget,
          keyboard: e.detail === 0,
          returnFocus: focused instanceof HTMLElement ? focused : null,
        });
      }}
    >
      <MoreIcon size={18} />
    </button>
  );
}

export function NodeActionsMenu() {
  const mobile = useIsMobile();
  const [request, setRequest] = useState<Request | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const firstItem = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    opener = (next) => {
      setRequest(next);
      setOpen(true);
    };
    return () => {
      opener = null;
    };
  }, []);

  // The instance id, as Cmd+K's ambient target reads `data-node-id`: position
  // verbs act where the row sits, and content verbs resolve mirrors themselves.
  // Cmd+K's order, except Delete, which a menu ends with behind a separator.
  const all = request
    ? buildNodeActions(
        instanceIdForKey(request.key),
        getTreeIndex(),
        getNodeActionBridge(),
      )
    : [];
  const actions = all.filter((a) => a.id !== DELETE_ID);
  const remove = all.find((a) => a.id === DELETE_ID);

  // Run after the overlay releases focus, so dialogs (Move, Mirror) and the
  // caret handoff in each action are not undone by focus restoration.
  const choose = (action: CommandCenterAction) => {
    setPending(() => action.run);
    setOpen(false);
  };
  const afterClose = () => {
    const run = pending;
    setPending(null);
    if (run) run();
    else if (request?.returnFocus?.isConnected)
      request.returnFocus.focus({ preventScroll: true });
    setRequest(null);
  };

  // A plain trigger, not a Base UI one, so keep its expanded state here.
  useLayoutEffect(() => {
    const trigger = request?.anchor;
    if (!trigger?.matches(".node-actions-trigger") || !open) return;
    trigger.setAttribute("aria-expanded", "true");
    return () => trigger.setAttribute("aria-expanded", "false");
  }, [request, open]);

  if (!request) return null;

  if (mobile) {
    return (
      <MenuSheetContent
        title="Bullet actions"
        isOpen={open}
        onOpenChange={setOpen}
        onAfterClose={afterClose}
      >
        <div role="menu" aria-label="Bullet actions" className="p-1">
          {actions.map((action) => (
            <SheetItem key={action.id} action={action} onChoose={choose} />
          ))}
          {remove && (
            <>
              <hr className="my-1 border-border" />
              <SheetItem action={remove} onChoose={choose} destructive />
            </>
          )}
        </div>
      </MenuSheetContent>
    );
  }

  return (
    <Menu.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        // A keyboard open enters the menu; a pointer open leaves focus on the
        // menu, so the first arrow key lands on the first item either way.
        if (next && request.keyboard)
          firstItem.current?.focus({ preventScroll: true });
        if (!next) afterClose();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={request.anchor}
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50"
        >
          <Menu.Popup
            data-node-actions-menu
            aria-label="Bullet actions"
            finalFocus={false}
            className="w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md outline-none"
          >
            <Menu.Group className="max-h-80 scroll-fade overflow-y-auto p-1">
              {actions.map((action, i) => (
                <MenuItem
                  key={action.id}
                  ref={i === 0 ? firstItem : undefined}
                  action={action}
                  onChoose={choose}
                />
              ))}
              {remove && (
                <>
                  <Menu.Separator className="my-1 h-px bg-border" />
                  <MenuItem action={remove} onChoose={choose} destructive />
                </>
              )}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MenuItem({
  ref,
  action,
  onChoose,
  destructive,
}: {
  ref?: RefObject<HTMLElement | null>;
  action: CommandCenterAction;
  onChoose: (action: CommandCenterAction) => void;
  destructive?: boolean;
}) {
  return (
    <Menu.Item
      ref={ref}
      label={action.label}
      onClick={() => onChoose(action)}
      data-variant={destructive ? "destructive" : undefined}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[variant=destructive]:text-destructive"
    >
      <action.icon className="size-4 shrink-0 opacity-70" />
      <span className="truncate">{action.label}</span>
      {action.hotkey && action.hotkey.length > 0 && (
        <KbdGroup className="ml-auto">
          {action.hotkey.map((k, i) => (
            <Kbd key={i}>{k}</Kbd>
          ))}
        </KbdGroup>
      )}
    </Menu.Item>
  );
}

function SheetItem({
  action,
  onChoose,
  destructive,
}: {
  action: CommandCenterAction;
  onChoose: (action: CommandCenterAction) => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-variant={destructive ? "destructive" : undefined}
      className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent data-[variant=destructive]:text-destructive"
      onClick={() => onChoose(action)}
    >
      <action.icon className="size-4 shrink-0 opacity-70" />
      {action.label}
    </button>
  );
}
