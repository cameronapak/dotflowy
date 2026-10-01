import type { VariantProps } from "class-variance-authority";

import { Star } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Logo } from "@/components/Logo";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

// Single source of truth for the outbound links. Handle is `cameronapak`.
export const APP_URL = "https://app.dotflowy.com";
export const GITHUB_URL = "https://github.com/cameronapak/dotflowy";
const GITHUB_API = "https://api.github.com/repos/cameronapak/dotflowy";
const X_URL = "https://x.com/cameronpak";

function useGithubStars() {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(GITHUB_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        if (!cancelled && typeof data?.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return stars;
}

/** A link styled as a button. Links are `<a>` elements (correct semantics),
 * not Base UI Buttons rendering an anchor. */
export function LinkButton({
  href,
  external,
  variant,
  size,
  className,
  children,
}: {
  href: string;
  external?: boolean;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {children}
    </a>
  );
}

export function Nav() {
  const stars = useGithubStars();
  return (
    <header>
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <a href="/" className="flex items-center">
          <Logo className="h-5 w-auto" />
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LinkButton
            href="/changelog"
            variant="ghost"
            size="sm"
            className="min-h-10 px-2.5"
          >
            What&apos;s new
          </LinkButton>
          <LinkButton
            href={GITHUB_URL}
            external
            variant="ghost"
            size="sm"
            className="min-h-10 min-w-10 gap-1.5 px-2.5 sm:min-w-0 sm:pr-2.5 sm:pl-2"
          >
            <Star className="size-4" />
            <span className="hidden sm:inline">Star on GitHub</span>
            {stars != null && (
              <span className="text-muted-foreground tabular-nums">
                {stars.toLocaleString()}
              </span>
            )}
          </LinkButton>
          <LinkButton
            href={APP_URL}
            variant="outline"
            size="sm"
            className="min-h-10 px-3"
          >
            Sign in
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center text-sm">
          <Logo className="h-4 w-auto" />
        </div>
        <nav className="flex flex-wrap items-center gap-5 text-sm text-muted-foreground">
          <a href={APP_URL} className="transition-colors hover:text-foreground">
            Open app
          </a>
          <a
            href="/changelog"
            className="transition-colors hover:text-foreground"
          >
            What&apos;s new
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href={`${APP_URL}/terms`}
            className="transition-colors hover:text-foreground"
          >
            Terms
          </a>
          <a
            href={`${APP_URL}/privacy`}
            className="transition-colors hover:text-foreground"
          >
            Privacy
          </a>
        </nav>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-6">
        <p className="text-xs text-muted-foreground/70">
          FAITH TOOLS SOFTWARE SOLUTIONS, LLC © {year}
        </p>
      </div>
      {/* Nominative-fair-use disclaimer: naming Workflowy is lawful, but state
       * plainly that we're independent and unaffiliated. */}
      <div className="mx-auto w-full max-w-2xl px-6 pb-6">
        <p className="text-xs leading-relaxed text-muted-foreground/70">
          Workflowy is a trademark of its respective owner. Dotflowy is an
          independent, open-source project and is not affiliated with, sponsored
          by, or endorsed by Workflowy.
        </p>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-10">
        <a
          href={X_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="group inline-flex items-center gap-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <img
            src="/cameron-pak.png"
            alt="Cameron Pak"
            width={28}
            height={28}
            className="size-7 rounded-full"
          />
          <span>
            Created and maintained by{" "}
            <span className="text-foreground/80 underline-offset-4 group-hover:underline">
              Cameron Pak
            </span>
          </span>
        </a>
      </div>
    </footer>
  );
}
