import type { ReactNode } from "react";

import {
  Bookmark,
  Calendar,
  Check as CheckIcon,
  ChevronRight,
  Command,
  Ellipsis,
  House,
  Search,
  Sparkle,
} from "lucide-react";

import { cn } from "@/lib/utils";

/* HTML replicas of the app's editor parts, measured against the running app
 * (`bun run cf:dev`) at its default reading size: 17px text on a 1.5 line,
 * a 16px bullet box holding a 7px dot, 24px per indent level, 16px checkbox.
 * Everything is in `em` of the row text so a replica scales as one object.
 * Sources: src/styles.css (.outline-row, .bullet, .bullet-dot, .collapse-toggle,
 * .md-spoiler, [data-faded]), plugins/tags/tag-classes.ts, plugins/provenance,
 * components/ui/tooltip.tsx, src/data/tag-colors.ts. */

export type TagColor =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "indigo"
  | "purple"
  | "pink";

/** `#tag` chip: the app's outline Badge, a full pill. Uncolored tags keep the
 * hairline border; a colored tag swaps it for the palette fill. */
export function TagChip({
  color,
  children,
  className,
}: {
  color?: TagColor;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-[0.55em] py-[0.08em] text-[0.85em] leading-[1.35] font-medium whitespace-nowrap",
        color ? "border-transparent" : "border-border text-foreground",
        className,
      )}
      style={
        color
          ? {
              background: `var(--tag-${color})`,
              color: `var(--tag-${color}-fg)`,
            }
          : undefined
      }
    >
      #{children}
    </span>
  );
}

/** The provenance tooltip, as the app's Tooltip draws it. `arrow` points up
 * at the sparkle it describes. */
export function ProvenanceTip({
  who = "Claude",
  when = "2m ago",
  arrow,
  className,
}: {
  who?: string;
  when?: string;
  arrow?: "up" | "down";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex items-center rounded-[0.4em] bg-foreground px-[0.85em] py-[0.4em] text-[0.72em] whitespace-nowrap text-background",
        className,
      )}
    >
      {arrow && (
        <span
          aria-hidden
          className={cn(
            "absolute left-[1.1em] size-[0.6em] rotate-45 rounded-[0.12em] bg-foreground",
            arrow === "up" ? "-top-[0.25em]" : "-bottom-[0.25em]",
          )}
        />
      )}
      Created by {who} · {when}
    </span>
  );
}

/** The sparkle an agent-created row carries between its dot and its text. */
export function AgentMark() {
  return (
    <Sparkle
      className="mt-[0.3em] size-[0.94em] shrink-0 text-muted-foreground"
      strokeWidth={2}
      aria-hidden
    />
  );
}

/** The todo checkbox: 16px, 4px radius, muted hairline; checked fills with
 * the primary and draws a 14px check. */
export function Check({
  done,
  className,
}: {
  done?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "mt-[0.25em] inline-flex size-[0.94em] shrink-0 items-center justify-center rounded-[0.24em] border",
        done
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground",
        className,
      )}
    >
      {done && (
        <CheckIcon className="size-[0.82em]" strokeWidth={2} aria-hidden />
      )}
    </span>
  );
}

/** `||spoiler||`: a muted-foreground bar the width of its hidden text. */
export function Spoiler({ children }: { children: string }) {
  return (
    <span className="rounded-[0.25em] bg-muted-foreground text-transparent">
      {children}
    </span>
  );
}

/** The 16px bullet box with its 7px dot. Collapsed rows get the ring that
 * signals hidden children. */
export function Bullet({
  collapsed,
  accent,
}: {
  collapsed?: boolean;
  accent?: boolean;
}) {
  return (
    <span
      className={cn(
        "mt-[0.32em] flex size-[0.94em] shrink-0 items-center justify-center rounded-full",
        collapsed && "bg-foreground/10",
      )}
    >
      <span
        className={cn(
          "size-[0.41em] rounded-full",
          accent ? "bg-brand-blue" : "bg-foreground/70",
        )}
      />
    </span>
  );
}

/** One outline row. `collapsed` also draws the gutter chevron, which the app
 * keeps visible on collapsed parents. `done` fades the whole row to 40% and
 * strikes the text, like `[data-faded]`. */
export function Row({
  depth = 0,
  children,
  collapsed,
  accent,
  task,
  agent,
  className,
}: {
  depth?: number;
  children: ReactNode;
  collapsed?: boolean;
  accent?: boolean;
  task?: "open" | "done";
  agent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex items-start gap-[0.35em] leading-[1.5]",
        task === "done" && "opacity-40",
        className,
      )}
      style={{ paddingLeft: `${depth * 1.41}em` }}
    >
      {collapsed && (
        <ChevronRight
          aria-hidden
          strokeWidth={2.5}
          className="absolute mt-[0.4em] size-[0.82em] -translate-x-[1.05em] text-muted-foreground"
        />
      )}
      <Bullet collapsed={collapsed} accent={accent} />
      {task && <Check done={task === "done"} />}
      {agent && <AgentMark />}
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-[0.3em]",
          task === "done" && "line-through",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The app's page: the header bar (home, chevron breadcrumb, toolbar icons)
 * over a hairline, then the zoomed title and rows. `framed` adds the card
 * edge a hero needs to sit on a page. */
export function AppPage({
  crumbs,
  title,
  children,
  className,
  toolbar = true,
}: {
  crumbs: string[];
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  toolbar?: boolean;
}) {
  const icon = "size-[1.05em] shrink-0";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[0.9em] border border-border bg-background",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-[1em] border-b border-border px-[1.1em] py-[0.7em] text-[0.82em] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-[0.45em]">
          <House
            className={cn(icon, "text-foreground/70")}
            strokeWidth={1.75}
            aria-hidden
          />
          {crumbs.map((c) => (
            <span key={c} className="flex min-w-0 items-center gap-[0.45em]">
              <ChevronRight
                className="size-[0.85em] shrink-0"
                strokeWidth={2}
                aria-hidden
              />
              <span className="truncate">{c}</span>
            </span>
          ))}
        </div>
        {toolbar && (
          <div className="flex items-center gap-[0.9em] text-foreground/80">
            <Calendar className={icon} strokeWidth={1.75} aria-hidden />
            <Bookmark className={icon} strokeWidth={1.75} aria-hidden />
            <Search className={icon} strokeWidth={1.75} aria-hidden />
            <Command className={icon} strokeWidth={1.75} aria-hidden />
            <Ellipsis className={icon} strokeWidth={1.75} aria-hidden />
          </div>
        )}
      </div>
      <div className="px-[1.3em] pt-[1em] pb-[1.2em]">
        {title && (
          <div className="mb-[0.35em] flex flex-wrap items-center gap-[0.4em] text-[1.4em] leading-tight font-semibold">
            {title}
          </div>
        )}
        <div className="space-y-[0.32em]">{children}</div>
      </div>
    </div>
  );
}

/** The ⌘K node switcher: filled search field, a "Nodes" group, the fuzzy
 * match highlighted, and the path underneath. */
export function NodeSwitcher({
  query,
  match,
  rest,
  path,
  className,
}: {
  query: string;
  match: string;
  rest: string;
  path: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[0.9em] border border-border bg-card p-[0.55em] text-[0.95em]",
        className,
      )}
    >
      <div className="flex items-center gap-[0.5em] rounded-[0.55em] bg-muted px-[0.7em] py-[0.45em]">
        <Search
          className="size-[1em] text-muted-foreground"
          strokeWidth={2}
          aria-hidden
        />
        <span>
          {query}
          <span className="ml-px inline-block h-[1em] w-[0.07em] translate-y-[0.15em] bg-foreground" />
        </span>
      </div>
      <p className="px-[0.6em] pt-[0.6em] pb-[0.3em] text-[0.8em] text-muted-foreground">
        Nodes
      </p>
      <div className="rounded-[0.55em] bg-muted px-[0.6em] py-[0.4em]">
        <p className="whitespace-nowrap">
          <span className="rounded-[0.15em] bg-foreground/15">{match}</span>
          {rest}
        </p>
        <p className="text-[0.85em] text-muted-foreground">{path}</p>
      </div>
    </div>
  );
}
