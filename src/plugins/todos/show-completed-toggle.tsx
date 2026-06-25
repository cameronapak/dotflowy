import { useId } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Switch } from "@/components/ui/switch";
import { useShowCompleted } from "./show-completed-provider";

/**
 * Header control mirroring Workflowy's completed-items toggle. Clicking the
 * check button flips "show completed" directly. Hovering reveals a small card
 * with the switch -- that's a visual readout of the current state, not the
 * primary control. State is global and persisted (see show-completed-provider).
 */
export function ShowCompletedToggle() {
  const switchId = useId();
  const { showCompleted, setShowCompleted } = useShowCompleted();

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-state={showCompleted ? "on" : "off"}
            className="data-[state=on]:bg-muted data-[state=on]:text-foreground"
            onClick={() => setShowCompleted(!showCompleted)}
            aria-pressed={showCompleted}
          >
            <CheckIcon />
            <span className="sr-only">
              {showCompleted ? "Hide completed" : "Show completed"}
            </span>
          </Button>
        }
      />
      <HoverCardContent align="end" className="w-auto">
        <label
          htmlFor={switchId}
          className="flex cursor-pointer items-center gap-2 font-medium select-none"
        >
          <Switch
            id={switchId}
            size="sm"
            checked={showCompleted}
            onCheckedChange={setShowCompleted}
          />
          Show completed
        </label>
      </HoverCardContent>
    </HoverCard>
  );
}
