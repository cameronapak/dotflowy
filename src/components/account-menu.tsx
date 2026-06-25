import { EllipsisVerticalIcon, LogOutIcon } from "lucide-react"
import { useNavigate } from "react-router"
import { logout, useAuth } from "wasp/client/auth"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

/** Header account menu — sign out and (later) account settings. */
export function AccountMenu() {
  const { data: user } = useAuth()
  const navigate = useNavigate()
  const email = user?.identities.email?.id

  async function handleLogout() {
    try {
      await logout()
      navigate("/login")
    } catch {
      console.error("Logout failed")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm">
            <EllipsisVerticalIcon />
            <span className="sr-only">Account menu</span>
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        className="w-56 max-w-[min(14rem,calc(100vw-2rem))]"
      >
        <DropdownMenuGroup>
          {email && (
            <>
              <DropdownMenuLabel
                className="block truncate font-normal"
                title={email}
              >
                {email}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => void handleLogout()}>
            <LogOutIcon />
            Log out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
