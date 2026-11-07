---
status: accepted
---

# Mobile navigation dock

Below 768px, the outline puts **Home** and **Today** in a centered bottom dock.
Both keep visible labels. At Home the header omits the redundant breadcrumb;
zoomed views retain their breadcrumb navigation.
Search and Quick-add are top-toolbar actions, alongside View options
and Account and help. Filter this view moves into the View menu. Desktop keeps
its existing controls. This is a width decision, like narrow-screen sheets
([ADR 0066](./0066-narrow-screen-menu-drawers.md)), not the pointer-type decision
that controls the editing toolbar ([ADR 0030](./0030-mobile-actions-bar.md)).

Cameron approved this separation after trying a prototype. The detached Search
and Add circles were removed because they competed with navigation. Apple's
[tab-bar guidance](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
separates navigation from actions, but explicitly permits a separate Search tab.
Putting Search and Quick-add at the top is our choice, not an Apple requirement.
The tradeoffs are poorer thumb reach and an extra tap for Filter.

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

Use the MIT-licensed `@onlymoein/liquidglass` TabBar, pinned to 0.11.2. Load it
with the mobile navigation chunk, not desktop's initial editor graph. Scope
palette overrides to the dock and follow Dotflowy's theme. Use the package's
own glass and selection lens without an additional background or selected fill.
Do not mark the editable outline `data-liquidglass-backdrop`: cloning an editor
and continuously refreshing that copy is inappropriate for this surface.

Reduced motion, reduced transparency, increased contrast, forced colors, or
missing backdrop-filter support replace TabBar with opaque SPA links. This
unmounts its glass effects rather than merely making an animated lens opaque.
The dock never auto-minimizes or follows scroll velocity. Labels and native link
semantics remain available to keyboard and assistive-technology users. Header
and dock targets are at least 44 CSS pixels.

The dock includes safe-area insets and reserves bottom document space so the
last node can scroll clear. A visual-viewport reduction greater than 100 CSS
pixels hides it, normalized for pinch zoom, leaving editing controls in charge.
This shares the existing docked-keyboard heuristic, not a universal keyboard API:
floating keyboards and engines without Visual Viewport cannot be detected.
Overlays retain the app's existing focus handling and modal layering.

## Verification and limits

Browser journeys cover navigation, selection, search, real capture persistence
through the app API contract, Filter focus, Daily-off, reduced-motion fallback,
keyboard geometry, target sizes, and the 767px/768px boundary. Check rendered
light, dark, opaque, narrow, and editing states, plus existing header, capture,
Day stream, and editing-toolbar journeys. Run the real Worker app before delivery.

Chromium supplies live refraction; WebKit supplies frost, blur, and rim without
the same live backdrop refraction. Neither desktop emulation nor Linux WebKit
proves real iPhone keyboard animation, safe-area reporting, screen-reader
behavior, or battery/GPU cost. Keep those on the physical-device checklist.
Pinning, integrity verification, an MIT license, and an advisory check are useful
adoption checks, not a security certification. No automated monitoring is implied.
