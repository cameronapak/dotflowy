import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";

import { tokenizeQuery } from "../data/filter-query";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const shortcuts = [
  { label: "To-do", term: "is:todo", include: "To-do", exclude: "Not a to-do" },
  {
    label: "Completed",
    term: "is:complete",
    include: "Completed",
    exclude: "Not completed",
  },
  {
    label: "Tag",
    term: "#",
    prefix: true,
    include: "Include tag…",
    exclude: "Exclude tag…",
  },
  {
    label: "Highlight",
    term: "highlight:",
    prefix: true,
    include: "Highlighted",
    exclude: "Not highlighted",
  },
  {
    label: "Has link",
    term: "has:link",
    include: "Has link",
    exclude: "No links",
  },
  {
    label: "Has children",
    term: "has:children",
    include: "Has children",
    exclude: "No children",
  },
];

/** Both Find and Filter expose the same text-producing include/exclude menus. */
export function QueryFilterChips({
  query,
  onChange,
}: {
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Query shortcuts"
      data-query-shortcuts
      className="flex gap-1 overflow-x-auto px-1 py-2"
    >
      {shortcuts.map((shortcut) => (
        <QueryShortcut
          key={shortcut.term}
          shortcut={shortcut}
          query={query}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function QueryShortcut({
  shortcut,
  query,
  onChange,
}: {
  shortcut: (typeof shortcuts)[number];
  query: string;
  onChange: (query: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const edited = useRef(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const tokens = tokenizeQuery(query);
  const active = tokens.filter((token) => {
    const term = token.replace(/^-/, "");
    return shortcut.prefix
      ? term.startsWith(shortcut.term)
      : term === shortcut.term;
  });
  const terms =
    shortcut.prefix && active.length
      ? [...new Set(active.map((token) => token.replace(/^-/, "")))]
      : [shortcut.term];

  function choose(term: string, next: string) {
    edited.current = true;
    const removing = new Set<number>();
    let replaced = false;
    const updated = tokens
      .map((token, i) => {
        if (token !== term && token !== `-${term}`) return token;
        if (next && !replaced) {
          replaced = true;
          return next;
        }
        removing.add(i);
        // Removing an OR operand also removes one adjoining OR, not its peer.
        if (tokens[i - 1] === "OR" && !removing.has(i - 1)) removing.add(i - 1);
        else if (tokens[i + 1] === "OR") removing.add(i + 1);
        return token;
      })
      .filter((_, i) => !removing.has(i));
    if (next && !replaced) updated.push(next);
    onChange(updated.join(" "));
  }

  const selected = active[0];
  const label = !selected
    ? shortcut.label
    : shortcut.prefix
      ? active.length > 1
        ? `${shortcut.label} (${active.length})`
        : `${selected.startsWith("-") ? "Not " : ""}${selected.replace(/^-/, "")}`
      : selected.startsWith("-")
        ? shortcut.exclude
        : shortcut.include;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        // A body portal is inert while Find's native phone sheet owns the top layer.
        if (open) {
          edited.current = false;
          setContainer(trigger.current?.closest("dialog") ?? null);
        }
      }}
    >
      <DropdownMenuTrigger
        ref={trigger}
        onKeyDown={(event) => event.stopPropagation()}
        render={
          <Button
            type="button"
            variant={active.length ? "secondary" : "outline"}
            size="xs"
            className="[@media(pointer:coarse)]:min-h-11"
          />
        }
      >
        {label}
        <HugeiconsIcon icon={ArrowDown01Icon} data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portalContainer={container ?? undefined}
        data-query-shortcut-menu
        finalFocus={() => (edited.current ? false : trigger.current)}
        onKeyDown={(event) => event.stopPropagation()}
        className="w-auto min-w-44 [&_[role^=menuitem]]:[@media(pointer:coarse)]:min-h-11"
      >
        {terms.map((term) => (
          <DropdownMenuGroup key={term}>
            {shortcut.prefix && active.length > 0 && (
              <DropdownMenuLabel>{term}</DropdownMenuLabel>
            )}
            <DropdownMenuRadioGroup
              value={
                tokens.includes(`-${term}`)
                  ? `-${term}`
                  : tokens.includes(term)
                    ? term
                    : ""
              }
            >
              <DropdownMenuRadioItem
                closeOnClick
                value=""
                onClick={() => choose(term, "")}
              >
                {shortcut.prefix ? "Remove filter" : "Any"}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                closeOnClick
                value={term}
                onClick={() => choose(term, term)}
              >
                {shortcut.prefix && active.length
                  ? `Include ${term}`
                  : shortcut.include}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                closeOnClick
                value={`-${term}`}
                onClick={() => choose(term, `-${term}`)}
              >
                {shortcut.prefix && active.length
                  ? `Exclude ${term}`
                  : shortcut.exclude}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}
        {shortcut.prefix && (
          <DropdownMenuGroup>
            {active.length > 0 && (
              <DropdownMenuItem
                onClick={() => choose(shortcut.term, shortcut.term)}
              >
                {shortcut.term === "#" ? "Add tag…" : "Choose color…"}
              </DropdownMenuItem>
            )}
            {active.length === 0 && shortcut.term === "highlight:" && (
              <DropdownMenuItem
                onClick={() => choose(shortcut.term, shortcut.term)}
              >
                Choose color…
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
