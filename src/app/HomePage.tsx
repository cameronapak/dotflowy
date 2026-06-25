import { logout, useAuth } from "wasp/client/auth";

// Auth-gated placeholder. Proves Phase 1's exit criteria (sign up -> land here
// authenticated). The outline editor replaces this in Phase 3.
export function HomePage() {
  const { data: user } = useAuth();

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 p-10">
      <h1 className="text-2xl font-semibold">Dotflowy</h1>
      <p className="text-neutral-600">
        You&apos;re signed in. The outline editor is ported in Phase 3 of the
        Wasp migration ({user ? "authenticated" : "no session"}).
      </p>
      <button
        onClick={logout}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-100"
      >
        Log out
      </button>
    </div>
  );
}
