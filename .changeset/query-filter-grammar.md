---
"dotflowy": minor
---

Query-filter grammar for `?q=` (ADR 0047, slice 1): the view filter now understands `-` (NOT), uppercase `OR`, `"quoted phrases"`, free-text substring, and `key:value` operators (`is:todo|bullet|paragraph|mirror|complete|agent`, `has:link`, `highlight:` + colors) alongside `#tag`. Operators are plugin-registered via a new `filterOperators` seam; a match now reveals its (undimmed) subtree. No new filter input UI yet (that is a later slice); the existing tag pill bar keeps working and no longer drops non-tag terms.
