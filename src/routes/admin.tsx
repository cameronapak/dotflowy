import { createFileRoute, Outlet } from "@tanstack/react-router";

import { Button } from "../components/ui/button";
import { useAdminAccess } from "../data/admin-access";

/**
 * Every /admin page renders only after the server says this session is an
 * admin (ADR 0090). Others get the same "Not found." as a missing page. This
 * hides admin UI; each admin API still authorizes every request itself.
 */
export const Route = createFileRoute("/admin")({
  component: AdminGate,
});

function AdminGate() {
  const { access, reload } = useAdminAccess();
  if (access === "loading") return null;
  if (access === "admin") return <Outlet />;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6">
      {access === "denied" ? (
        <p className="text-sm text-muted-foreground">Not found.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Couldn&rsquo;t reach Dotflowy. Check your connection and try again.
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </>
      )}
    </main>
  );
}
