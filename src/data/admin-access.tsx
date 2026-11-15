import { Schema } from "effect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Whether the server says this session is an admin (ADR 0090). A display hint
 * for menus, Find, and the admin pages; every admin API checks the session
 * itself. Not persisted: an account switch reloads the page (AuthGate), and
 * focus revalidates so a removed admin loses the entry on the next return.
 */
export type AdminAccess = "loading" | "error" | "admin" | "denied";

const Capabilities = Schema.Struct({ admin: Schema.Boolean });

const Context = createContext<{ access: AdminAccess; reload: () => void }>({
  access: "loading",
  reload: () => {},
});

export function AdminAccessProvider({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<AdminAccess>("loading");
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/api/account-capabilities", { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return "denied";
        if (!response.ok) throw new Error("Capabilities unavailable");
        const { admin } = Schema.decodeUnknownSync(Capabilities)(
          await response.json(),
        );
        return admin ? "admin" : "denied";
      })
      .then((next: AdminAccess) => {
        if (active) setAccess(next);
      })
      .catch(() => {
        // A failed revalidation keeps a known answer, so an open admin page
        // and its drafts survive a network blip; only a first check errors.
        if (active)
          setAccess((current) => (current === "loading" ? "error" : current));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [revision]);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return (
    <Context.Provider value={{ access, reload }}>{children}</Context.Provider>
  );
}

export const useAdminAccess = () => useContext(Context);
