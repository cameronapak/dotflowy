---
status: accepted
---

# Owner-controlled node locking

A node may be **Locked** by its owner in the editor. Locking protects authored content recursively across the full subtree and across mirrors, while still allowing the protected subtree to move intact. This is durable mutation protection, not secrecy or the plugin-defined scaffold protection from ADR 0015, so the Durable Object enforces it for every ordinary write path.

## Product contract

- The editor exposes **Lock** and **Unlock** through `/` commands, Cmd+K, and multi-select actions. Rows and zoomed titles show a lock indicator. There is no new bullet-dot menu or keyboard shortcut.
- Only the human editor may create or remove a lock. MCP and CLI callers can observe effective locks and receive useful rejection errors, but cannot lock or unlock nodes.
- A lock covers the node and every descendant at every depth. Text, Kind, Completed, insertion, deletion, and structural changes inside that subtree are blocked.
- Collapse/expand and bookmark/unbookmark remain allowed because they are view state, not authored content.
- The locked subtree's root may move or reorder as one intact unit. An unlocked ancestor may also move while carrying locked descendants. Deleting that root or an ancestor containing it is blocked, as are moving descendants out, moving other nodes in, or changing relationships within the locked subtree.
- Direct locks stack. A descendant lock that predates an ancestor lock remains after the ancestor is unlocked. While an ancestor lock applies, descendant lock controls are disabled rather than silently changing direct locks.
- Normal undo and redo obey current locks. Administrative snapshot and point-in-time recovery bypass them so disaster recovery cannot be made impossible.
- Reading, search, copy, and export remain allowed. Ordinary pasted or imported copies are unlocked. Whole-outline backups preserve direct lock state.

## Mirrors

Locking a source or any mirror locks the source content and its subtree in every instance. Lock inheritance also crosses a mirror inside a locked subtree: otherwise another instance could change content rendered inside something that claims to be locked. Resolution must be cycle-safe under ADR 0022's mirror rules.

The direct lock belongs to the true source. A lock command issued on a mirror updates that source; mirror instance position, collapse, and bookmark remain local. The editor distinguishes a direct lock, which its owner may unlock, from an inherited lock, whose control is disabled until the locking ancestor is unlocked.

## Storage and enforcement

Add a required `locked: boolean` Node field, defaulted to `false` by every node constructor and legacy-row boundary. Store only direct owner intent; derive effective locking from ancestry and mirror resolution instead of rewriting every descendant.

The Durable Object is the authoritative gate. Before committing an ordinary batch or field write, it validates the resulting logical tree against the pre-write lock graph. Validation is semantic rather than a blanket ban on row updates because an allowed root relocation can legitimately change linked-list pointers on locked nodes and their siblings. A valid ordinary write must preserve every effectively locked node and the authored content and internal relationships of its protected subtree; only whole-subtree location plus collapse and bookmark may differ. The whole batch fails atomically on violation.

Client guards provide immediate disabled controls, row feedback, and a toast, but are not trusted enforcement. MCP planners, quick-add, daily materialization, imports, normal history restore, direct REST field writes, and structural batches all receive the same Durable Object decision. Administrative whole-outline restore uses an explicit bypass rather than weakening the ordinary write gate. Lunora's retained retirement schemas preserve the field, but its retired mutators are not an ordinary user-facing write path.

MCP node results expose whether each node is effectively locked. Rejected tools return a specific locked-node tool error so agents can adapt rather than seeing an internal failure. The CLI inherits both behavior and output from MCP.

## Consequences

- Locking remains one small write regardless of subtree size, while validation pays the graph walk at the authoritative boundary.
- Existing plugin protection remains separate: it protects load-bearing scaffold identity but deliberately allows edits and children, and uses a plugin-owned indicator when supplied; Locked protects owner-authored content recursively and retains the lock glyph.
- Tests must falsify both sides of the boundary: an intact root move succeeds, while descendant edits, insertion, extraction, ancestor deletion, mirror-side edits, undo, MCP, and CLI writes fail atomically. Recovery bypass, view-state changes, unlocked copies, nested direct locks, and cross-mirror inheritance require explicit coverage.
