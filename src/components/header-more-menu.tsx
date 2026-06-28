import {
  CircleCheckIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  SunIcon,
  SunMoonIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { signOut } from "../lib/auth-client";
import { useShowCompleted } from "./show-completed-provider";
import { useTheme } from "./theme-provider";

/**
 * Header overflow ("More") menu. Holds the secondary, set-once controls --
 * theme, show-completed, sign out -- so the header bar keeps only the primary,
 * frequently reached actions (search, the contextual bookmark star, plugin
 * header slots).
 *
 * This is the static v1 of the header-action overflow: the pinned/overflow
 * split is a fixed default. User-customizable pinning (Chrome-extension style)
 * is the planned v2 and will land with its own ADR + a per-user pin collection.
 *
 * Each control is re-expressed in its native menu idiom (theme = radio submenu,
 * show-completed = checkbox item) so its on/off state still reads from inside
 * the menu, not just as a bar button.
 */
export function HeaderMoreMenu() {
  const { theme, setTheme } = useTheme();
  const { showCompleted, setShowCompleted } = useShowCompleted();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="More">
            <MoreHorizontalIcon />
            <span className="sr-only">More actions</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunMoonIcon />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) =>
                setTheme(value as "light" | "dark" | "system")
              }
            >
              <DropdownMenuRadioItem value="light">
                <SunIcon />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuCheckboxItem
          checked={showCompleted}
          onCheckedChange={setShowCompleted}
        >
          <CircleCheckIcon />
          Show completed
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onClick={() => signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
