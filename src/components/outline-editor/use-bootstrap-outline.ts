import { useEffect } from "react";
import { bootstrapOutline } from "../../data/seed";

/**
 * First-run bootstrap: import a pre-D1 localStorage outline if present, else
 * seed the welcome bullets. Both await the collection's initial D1 load and
 * no-op unless the server is empty (seed.ts / import-legacy.ts), so this is
 * safe to call unconditionally on mount.
 *
 * bootstrapOutline returns a BootstrapError as a value (errore convention) when
 * the initial D1 load failed -- it detects that deliberately, because the query
 * adapter resolves an empty array (and logs its own error) rather than rejecting
 * on a 500/offline. We log here too for a single, app-level "bootstrap skipped
 * because the load failed" signal, so the seed never runs over a just-
 * unreachable outline. The trailing .catch is a backstop for anything truly
 * unexpected (e.g. a localStorage quota throw) so the mount effect can never
 * produce an unhandled rejection.
 */
export function useBootstrapOutline() {
  useEffect(() => {
    bootstrapOutline()
      .then((err) => {
        if (err instanceof Error)
          console.error("Outline bootstrap skipped:", err);
      })
      .catch((err) => console.error("Outline bootstrap threw:", err));
  }, []);
}
