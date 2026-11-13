import { Schema } from "effect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { subscription } from "../lib/auth-client";
import { MembershipSchema, type Membership } from "./membership-schema";

export async function startCheckout(
  plan: "unlimited" | "founding",
  annual: boolean,
) {
  const { error } = await subscription.upgrade({
    plan,
    annual,
    successUrl: "/settings?checkout=success",
    cancelUrl: "/settings?checkout=canceled",
  });
  if (error)
    throw new Error(
      error.message ?? "Couldn't start checkout. Please try again.",
    );
}

const initial = {
  state: "loading" as const,
  plan: null,
  subs: [],
  legacyLeaf: false,
  welcome: null,
};
type Snapshot = Omit<Membership, "plan"> & {
  state: "loading" | "error" | "ready";
  plan: Membership["plan"] | null;
};
let snapshot: Snapshot = initial;
const Context = createContext<Snapshot & { reload: () => void }>({
  ...initial,
  reload: () => {},
});

// Event-time access for the theme action, which is shared by Settings and ⌘K.
export const peekMembership = () => snapshot;

export function MembershipProvider({ children }: { children: ReactNode }) {
  const [membership, setMembership] = useState<Snapshot>(initial);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/api/membership", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Membership unavailable");
        return Schema.decodeUnknownSync(MembershipSchema)(
          await response.json(),
        );
      })
      .then((data) => {
        if (active) {
          snapshot = { ...data, state: "ready" };
          setMembership(snapshot);
        }
      })
      .catch(() => {
        if (active) {
          snapshot = { ...initial, state: "error" };
          setMembership(snapshot);
        }
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
    <Context.Provider value={{ ...membership, reload }}>
      {children}
    </Context.Provider>
  );
}

export const useMembership = () => useContext(Context);
