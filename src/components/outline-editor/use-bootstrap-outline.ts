import { useEffect } from "react";
import { useAuth } from "wasp/client/auth";
import { bootstrapOutline } from "../../data/seed";

/**
 * First-run bootstrap: import a pre-D1 localStorage outline if present, else
 * seed the welcome bullets for the signed-in user. Both await the collection's
 * initial load and no-op unless the server silo is empty (seed.ts /
 * import-legacy.ts), so this is safe to call unconditionally on mount.
 */
export function useBootstrapOutline() {
  const { data: user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;
    bootstrapOutline(user.id)
      .then((err) => {
        if (err instanceof Error)
          console.error("Outline bootstrap skipped:", err);
      })
      .catch((err) => console.error("Outline bootstrap threw:", err));
  }, [user?.id]);
}
