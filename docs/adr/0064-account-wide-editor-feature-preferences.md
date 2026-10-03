---
status: accepted
---

# Account-wide editor feature preferences

Bible references and Daily notes are optional editor features, enabled by
default. Their preferences belong to the signed-in user and follow that account
across devices. Turning either feature off changes the app experience, not
stored outline content or the permissions of external tools.

## Agreed boundaries

- Bible references off leaves reference text unchanged and stops Bible-specific
  rendering and panels.
- Daily notes off hides the app's Today and calendar controls and daily commands.
  Existing notes and daily-index mappings remain. Re-enabling uses the same data.
- Daily-specific date chips, badges, pickers, and navigation also stop while the
  feature is off. Source text remains unchanged, and existing daily notes remain
  accessible as ordinary outline nodes.
- Opening `/today` while Daily notes is off redirects to the top-level outline
  with a brief "Daily notes is off" message and creates nothing. Direct links to
  existing note nodes still work.
- Daily scaffold protection remains active while the feature is off, including
  the container, years, months, and weeks. Disabling editor conveniences must not
  make a structural delete cascade through existing notes. This preserves
  [protected-node enforcement](./0015-protected-nodes.md) and the
  [daily hierarchy](./0052-daily-calendar-hierarchy.md).
- Quick-add falls back to the top level when Daily notes is off, using the
  existing [capture-destination contract](./0049-quick-add-capture-surface.md).
- Explicit CLI and MCP daily commands remain available. Editor preferences are
  not access controls; paid entitlements and spoiler redaction stay unchanged
  under the [CLI compatibility contract](./0061-cli-mcp-compatibility.md).
- Apply preference changes immediately in the tab where the user toggles them.
  Other tabs and devices refresh on focus, matching the existing side-collection
  behavior. Applying a change does not reload the page or navigate away from the
  current note.

This is not plugin unloading. Reviewed plugins remain compiled into the bundle
under [ADR 0001](./0001-plugin-architecture.md) and
[ADR 0031](./0031-two-lane-plugin-trust.md). Only Bible references and Daily notes
gain switches in this change, not tasks, spoilers, or every registered plugin.

## Settings surface

Use the approved A layout without a fabricated outline preview. Preserve the
existing MCP setup dialog and account, billing, and import/export functionality.
Add a separate CLI setup dialog under Connections with npm installation,
browser login, and a safe outline read. Keep `cli/README.md` canonical for CLI
instructions rather than creating another guide.

CLI setup targets the deployment currently open in the app. Hosted Dotflowy uses
the short `dotflowy login` and `dotflowy outline` commands. Self-hosted deployments
include `--server <current origin>` in both commands. Login does not change the
CLI's default server, so the first read needs the same explicit server selection.

## Persistence and readiness

Store separate `editor-feature:bible` and `editor-feature:daily` rows in the
existing per-user `account-prefs` namespace. Missing rows mean enabled. Decode
recognized rows with Effect Schema and leave unrelated account preferences
untouched. Save optimistically and roll back a rejected write.

Optional controls wait for the initial account read. `/today` and quick-add also
wait before choosing a write destination. A failed read keeps the switches
unavailable until a successful retry; a failed focus refresh retains the last
known preferences. Focus refresh does not move an already-started capture or
override a destination the user explicitly chose. The next capture uses the
current default.
