---
status: accepted
---

# Integrated desktop PWA title bar

Installed desktop Chromium apps opt into `window-controls-overlay`, with
`standalone` as the manifest fallback. The existing desktop breadcrumbs and
actions share the native title-bar row. Browser tabs, unsupported browsers and
the browser's overlay-off setting retain the normal header.

The active display-mode media query owns the layout. CSS `titlebar-area-*`
environment values supply its position, width and height and update with native
geometry. Do not hard-code a Mac inset or make the app row taller than the
native region: the approved Mac prototype initially centered a 48px row beside
38px native controls, placing its icons 5px too low. Buttons stay centered and
interactive with `no-drag`; empty header space drags the window. Native traffic
lights, caption buttons and the browser menu remain browser/OS-owned.

Settings, auth, loading and narrow windows without the desktop header reserve
a separate, themed native-height drag strip. Narrow windows keep their existing
mobile toolbar and dock, rather than squeezing touch targets into the native
row ([ADR 0076](./0076-mobile-navigation-dock.md)). The editor remains a
screen-height shell with its own scroller ([ADR 0077](./0077-screen-height-editor-shell.md)).
Writing still fades the app's navigation without changing its geometry
([ADR 0078](./0078-writing-chrome.md)); native controls are unaffected.

Use existing `--background` and foreground tokens. The cached startup theme and
live `theme-color` synchronization already follow presets, custom themes and
Light/Dark/System ([ADR 0082](./0082-color-themes.md)). No theme preference,
JavaScript geometry controller, plugin seam or Node field is added. The static
white manifest fallback remains; a zero-flash cold launch is not guaranteed.

The implementation was exercised in installed Chrome 156 on macOS 27.2,
including native geometry, theme changes, System changes, narrow breadcrumbs,
125% browser zoom, menus and overlay-off fallback. Narrow windows and scrolled
Settings retain a native-height strip without covering their controls.
Browser-tab simulations do not prove native chrome behavior. Windows/Linux/Edge
native control geometry requires separate installation testing; Safari, Firefox
and mobile retain their ordinary layout.
