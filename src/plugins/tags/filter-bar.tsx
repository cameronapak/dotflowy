import { X } from "lucide-react";

import { Badge, Button } from "@/plugins/kit";

import { useTagFilter } from "./use-tag-filter";

function TagPill({
  tag,
  onRemove,
}: {
  tag: string;
  onRemove: (tag: string) => void;
}) {
  const name = tag.slice(1);
  return (
    <Badge
      variant="outline"
      data-tag-pill
      data-tag={name}
      className="gap-0.5 pr-0.5"
    >
      {tag}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-tag-pill-remove
        className="size-5 shrink-0 text-inherit opacity-60 hover:!bg-current/10 hover:!text-inherit hover:opacity-100 dark:hover:!bg-current/15"
        aria-label={`Remove ${tag} from filter`}
        onClick={() => onRemove(tag)}
      >
        <X />
      </Button>
    </Badge>
  );
}

function TagFilterBar({
  tags,
  onRemove,
  onClear,
}: {
  tags: string[];
  onRemove: (tag: string) => void;
  onClear: () => void;
}) {
  return (
    <search
      aria-label="Tag filter"
      className="flex flex-wrap items-center gap-1.5"
    >
      {tags.map((tag) => (
        <TagPill key={tag} tag={tag} onRemove={onRemove} />
      ))}
      <Button type="button" variant="ghost" size="xs" onClick={onClear}>
        Clear
      </Button>
    </search>
  );
}

/** Subheader slot: active-tag pills while a `?q=` filter is on. */
export function TagFilterSubheader() {
  const { activeTags, removeTag, clearTags } = useTagFilter();
  if (activeTags.length === 0) return null;
  return (
    <TagFilterBar tags={activeTags} onRemove={removeTag} onClear={clearTags} />
  );
}
