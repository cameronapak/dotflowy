# Subheader vs header slot

**Header slots** are persistent actions in the header's right cluster (the daily "Today" button).
**Subheader slots** are contextual state below the header — the tag filter bar, a future week nav,
a pomodoro timer. The core renders every non-null subheader slot into one **muted band**
(`bg-muted/30`) that **collapses with animation** when all slots return null and **sticks with the
header** as one unit. Header = "do something"; subheader = "here's what's shaping the view."

**Don't** put contextual/filter UI in header slots (wrong semantics, competes with global actions)
or leave it inline above the outline content (it's chrome, not document). Multi-slot layout within
the band (leading/main/trailing regions) is deferred until a second consumer ships — v1 renders all
non-null slots in one flex row.

**Amendment ([ADR 0074](./0074-focus-sessions.md)).** The focus session band is the second plugin
consumer, and the first that follows you across every view. It renders as its own full-width row at
the top of the subheader, above view-specific content such as the Daily week strip and the filter bar.
View-specific slots keep sharing the row below it.
