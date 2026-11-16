import { createFileRoute, Link } from "@tanstack/react-router";

import { AdminNav } from "../components/admin-nav";
import { ChevronRightIcon } from "../lib/icons";

/** Admin home (ADR 0090): links only. Opening a page never changes data. */
export const Route = createFileRoute("/admin/")({
  component: AdminHome,
});

const PAGES = [
  {
    to: "/admin/feedback",
    title: "Feedback inbox",
    description: "Read, triage, and answer private reports.",
  },
  {
    to: "/admin/waitlist",
    title: "Waitlist",
    description: "See who is waiting and copy their emails.",
  },
  {
    to: "/admin/restore",
    title: "Restore a user",
    description:
      "Roll one outline back within 30 days. Destructive; you review before it runs.",
    destructive: true,
  },
] as const;

function AdminHome() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 bg-background p-6">
      <AdminNav home />
      <h1 className="text-xl font-semibold">Admin</h1>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
        {PAGES.map((page) => (
          <li key={page.to}>
            <Link
              to={page.to}
              className="flex min-h-14 items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="flex flex-1 flex-col gap-0.5">
                <span
                  className={
                    "destructive" in page
                      ? "text-sm font-medium text-destructive"
                      : "text-sm font-medium"
                  }
                >
                  {page.title}
                </span>
                <span className="text-sm text-muted-foreground">
                  {page.description}
                </span>
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
