import { X } from "lucide-react";

import { Badge, Button } from "@/plugins/kit";

import { useTagFilter } from "./use-tag-filter";

/** A `#tag` surface token gets its painted chip (`data-tag` -> TagColorStyles);
 *  every other term (`is:todo`, `"a phrase"`, `-word`, `OR`) is a plain outline
 *  pill. Slice 1 renders the whole query faithfully; the compose/edit UI is a
 *  later slice. */
function isTagToken(token: string): boolean {
  return /^#[\p{L}\p{N}_-]+$/u.test(token);
}

function FilterPill({
  token,
  onRemove,
}: {
  token: string;
  onRemove: (token: string) => void;
}) {
  const isTag = isTagToken(token);
  return (
    <Badge
      variant="outline"
      {...(isTag ? { "data-tag-pill": true, "data-tag": token.slice(1) } : {})}
      className="gap-0.5 pr-0.5"
    >
      {token}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-tag-pill-remove
        className="size-5 shrink-0 text-inherit opacity-60 hover:!bg-current/10 hover:!text-inherit hover:opacity-100 dark:hover:!bg-current/15"
        aria-label={`Remove ${token} from filter`}
        onClick={() => onRemove(token)}
      >
        <X />
      </Button>
    </Badge>
  );
}

function FilterBar({
  tokens,
  onRemove,
  onClear,
}: {
  tokens: string[];
  onRemove: (token: string) => void;
  onClear: () => void;
}) {
  return (
    <search
      aria-label="Tag filter"
      className="flex flex-wrap items-center gap-1.5"
    >
      {tokens.map((token, i) => (
        // Tokens can repeat (two `#a`s), so the key includes the index.
        <FilterPill key={`${token}:${i}`} token={token} onRemove={onRemove} />
      ))}
      <Button type="button" variant="ghost" size="xs" onClick={onClear}>
        Clear
      </Button>
    </search>
  );
}

/** Subheader slot: the active `?q=` terms as removable pills. */
export function TagFilterSubheader() {
  const { tokens, removeToken, clear } = useTagFilter();
  if (tokens.length === 0) return null;
  return <FilterBar tokens={tokens} onRemove={removeToken} onClear={clear} />;
}
