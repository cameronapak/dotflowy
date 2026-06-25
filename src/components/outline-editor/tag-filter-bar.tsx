import { X } from "lucide-react";

/**
 * The active-tag filter bar: a row of tag pills, shown only while a filter is
 * on. Each pill's ✕ drops that one tag; "Clear" drops the whole filter. Tags
 * are *added* by clicking chips in the outline, never typed here -- v1 is
 * tags-only and click-driven. See ADR 0015.
 */
function TagPill({
  tag,
  onRemove,
}: {
  tag: string;
  onRemove: (tag: string) => void;
}) {
  const name = tag.slice(1);
  return (
    <span className="tag-pill" data-tag={name}>
      {tag}
      <button
        type="button"
        className="tag-pill-remove"
        aria-label={`Remove ${tag} from filter`}
        onClick={() => onRemove(tag)}
      >
        <X size={12} strokeWidth={2.5} />
      </button>
    </span>
  );
}

export function TagFilterBar({
  tags,
  onRemove,
  onClear,
}: {
  tags: string[];
  onRemove: (tag: string) => void;
  onClear: () => void;
}) {
  return (
    <search aria-label="Tag filter" className="tag-filter-bar">
      {tags.map((tag) => (
        <TagPill key={tag} tag={tag} onRemove={onRemove} />
      ))}
      <button type="button" className="tag-filter-clear" onClick={onClear}>
        Clear
      </button>
    </search>
  );
}
