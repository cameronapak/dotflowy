import { Link } from "@tanstack/react-router";

import { ArrowLeftIcon } from "@/lib/icons";

import { buttonVariants } from "./ui/button-variants";

/** The admin pages' shared way out: Admin home, then the outline (ADR 0090). */
export function AdminNav({ home = false }: { home?: boolean }) {
  const link = buttonVariants({
    variant: "ghost",
    size: "sm",
    className: "pointer-coarse:h-10",
  });
  return (
    <nav aria-label="Admin" className="-ml-2.5 flex flex-wrap gap-1">
      {!home && (
        <Link to="/admin" className={link}>
          <ArrowLeftIcon data-icon="inline-start" />
          Admin
        </Link>
      )}
      <Link to="/" className={link}>
        {home && <ArrowLeftIcon data-icon="inline-start" />}
        Back to outline
      </Link>
    </nav>
  );
}
