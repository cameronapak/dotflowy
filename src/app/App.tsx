import { Outlet } from "react-router";
import { useAuth } from "wasp/client/auth";
import { ThemeProvider } from "../components/theme-provider";
import { ShowCompletedProvider } from "../plugins/todos/show-completed-provider";
import { NodeSwitcher } from "../components/node-switcher";
import { MoveDialog } from "../components/move-dialog";
import { TagColorStyles } from "../plugins/tags/tag-color-menu";
import { PluginStyles } from "../components/plugin-styles";
import { Toaster } from "../components/ui/sonner";
import "../styles.css";

/**
 * Root component wrapping every page (client.rootComponent in main.wasp.ts).
 * Replaces the old TanStack `__root.tsx`: app-wide theme + show-completed
 * context, the toast host, and the editor's singleton chrome (Cmd+K switcher,
 * /move dialog, the generated tag-color and plugin stylesheets).
 *
 * The chrome is gated on an authenticated user: those components read
 * nodesCollection / tagColorsCollection, whose queries hit getNodes /
 * getTagColors and 401 without a session, so they must not mount on the
 * login / signup pages. Mounting them HERE (above the route Outlet) rather than
 * inside the page keeps them alive across `/`<->`/:nodeId` zoom navigations —
 * one persistent stylesheet, no per-zoom remount flash.
 */
export function App() {
  const { data: user } = useAuth();
  return (
    <ThemeProvider>
      <ShowCompletedProvider>
        <div className="min-h-screen bg-background text-foreground">
          <Outlet />
        </div>
        {user && (
          <>
            <NodeSwitcher />
            <MoveDialog />
            <TagColorStyles />
            <PluginStyles />
          </>
        )}
        <Toaster />
      </ShowCompletedProvider>
    </ThemeProvider>
  );
}
