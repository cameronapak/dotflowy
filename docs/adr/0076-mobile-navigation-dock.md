---
status: accepted
---

# Mobile navigation dock

Below 768px, the outline puts **Home** and **Today** in a centered bottom dock.
Both keep visible labels. The top of the page is a glass toolbar in the iOS
shape: the way back on the leading edge, then **Search** and **More** sharing
one piece of glass, then **Quick-add** as the one prominent action. Desktop keeps
its existing controls. This is a width decision, like narrow-screen sheets
([ADR 0066](./0066-narrow-screen-menu-drawers.md)), not the pointer-type decision
that controls the editing toolbar ([ADR 0030](./0030-mobile-actions-bar.md)).

Cameron approved this separation after trying a prototype. The detached Search
and Add circles were removed because they competed with navigation. Apple's
[tab-bar guidance](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
separates navigation from actions, but explicitly permits a separate Search tab.
Putting Search and Quick-add at the top is our choice, not an Apple requirement.
The tradeoffs are poorer thumb reach and an extra tap for Filter.

## Toolbar and breadcrumb

At Home the toolbar has no leading content; the dock owns navigation. On a
zoomed page the leading edge is **Back to the direct parent**, labelled with the
parent's name, or a Home glyph at the top level. A chevron beside it opens the
existing breadcrumb sheet, listing Home first and then every other ancestor.
The focused node is not repeated; it is the page title below.

Cameron chose this over a glass restyle of the old trail, Home › … › parent,
after comparing both in a live lab. The old trail lost the Home button and the
parent name at 320px, and the restyle lost the parent name at 360px. Back +
chevron keeps a truncated parent name at both. Apple's
[toolbar guidance](https://developer.apple.com/design/human-interface-guidelines/toolbars)
puts the way back and the title on the leading edge, one prominent action on the
trailing edge, and at most three groups; this toolbar has three.

Space is the reason for the **More menu**: one sheet with the View menu's
items, then an Account and help section with the App menu's. This amends the
two-menu split in [ADR 0072](./0072-split-header-view-and-app-menus.md) on
narrow screens only. The accepted cost is a long sheet that scrolls to Sign out.
The unread-release dot moves to the More trigger, and its name gains
"(new releases available)". Filter this view stays first in the View section.
Plugin header slots without a dock tab, such as Scribble's off-switch, join
Search and More in their glass group; the Spotlight indicator stays outside it.

## Existing behavior and plugin ownership

Home uses `/`. Today shares the existing header action, including seed-entry,
focus-last, and in-stream scrolling; `/today` remains its normal link destination
for modified clicks and opening a new tab. Search opens the command center, not the
view filter. Quick-add opens the existing capture overlay; it does not navigate
to its destination. Capture's write timing and destination rules are unchanged.
The floating Quick-add button remains on wider touch screens and pages without
the outline header, but not beside the narrow-screen header's Quick-add control.

`HeaderSlotSpec.mobileTab` optionally projects a header destination into the dock.
The plugin supplies its label, icon, existing href, active-state predicate, and
optional same-tab `onSelect` handler; core owns layout and SPA links. Daily owns
Today, including the distinction between a day note, another scaffold node, and
a Day stream section. Turning Daily notes off removes Today, leaving Home,
without changing stored nodes.
Other zoomed pages select neither tab. No invented destinations or Node fields.

## Glass and fallbacks

Use the MIT-licensed `@onlymoein/liquidglass` TabBar for the dock and its
Toolbar, ToolbarGroup and Button for the header, pinned to 0.11.2. Load them
with the mobile chunks, not desktop's initial editor graph. Scope palette
overrides to each surface and follow Dotflowy's theme, not the OS appearance:
the package reads `prefers-color-scheme`, so the header pins both its light and
dark values. Use the package's own glass, selection lens and scroll-edge band
without an additional background or selected fill. Quick-add's fill is
`--primary`. Menus stay Dotflowy's React Aria sheets, not the package's Menu.
Do not mark the editable outline `data-liquidglass-backdrop`: cloning an editor
and continuously refreshing that copy is inappropriate for this surface.

Reduced motion, reduced transparency, increased contrast, forced colors, or
missing backdrop-filter support replace TabBar with opaque SPA links and the
header's glass groups with bordered opaque controls, through one shared check.
This unmounts the glass effects rather than merely making them opaque.
The dock never auto-minimizes or follows scroll velocity. Labels and native link
semantics remain available to keyboard and assistive-technology users. Header
and dock targets are at least 44 CSS pixels.

The header pads its sides with `max(12px, env(safe-area-inset-*))`; the
body's existing padding keeps the top inset.
The dock includes safe-area insets and reserves bottom document space so the
last node can scroll clear. A visual-viewport reduction greater than 100 CSS
pixels hides it, normalized for pinch zoom, leaving editing controls in charge.
This shares the existing docked-keyboard heuristic, not a universal keyboard API:
floating keyboards and engines without Visual Viewport cannot be detected.
Overlays retain the app's existing focus handling and modal layering.

## Verification and limits

Browser journeys cover navigation, selection, search, real capture persistence
through the app API contract, Filter focus, Back and the breadcrumb sheet, the
More menu, Daily-off, reduced-motion fallback, keyboard geometry, target sizes,
and the 767px/768px boundary. Check rendered
light, dark, opaque, narrow, and editing states, plus existing header, capture,
Day stream, and editing-toolbar journeys. Run the real Worker app before delivery.

Chromium supplies live refraction; WebKit supplies frost, blur, and rim without
the same live backdrop refraction. Neither desktop emulation nor Linux WebKit
proves real iPhone keyboard animation, safe-area reporting, screen-reader
behavior, or battery/GPU cost. Keep those on the physical-device checklist.
Pinning, integrity verification, an MIT license, and an advisory check are useful
adoption checks, not a security certification. No automated monitoring is implied.
