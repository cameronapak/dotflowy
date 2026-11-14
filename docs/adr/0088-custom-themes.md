---
status: accepted
---

# Custom themes

Pro and Founding members can make their own color theme. They pick a color by
dragging a dot over a field of dots, the way Arc picks a window color: across
is hue, up is vividness. An optional second color and a Page slider, from
Paper to Wash, finish it. Nobody enters a hex value. Dotflowy derives every
token from those few choices and keeps it readable.

Custom is one more theme beside the presets in [ADR 0082](./0082-color-themes.md),
and it follows that ADR's selection, Mode, preview, and gating rules unless
this ADR says otherwise.

## The stored value

A custom theme is the `appearance:color-theme` row's value, like a preset id:
`custom:1:h,c,tint` or `custom:1:h,c,tint,h2,c2`. `h` is an OKLCH hue in
degrees, `c` its chroma (0 to 0.25), `tint` how much the page takes the color
(0 to 1), and `h2,c2` the optional second color. The `1` versions the
derivation, so a later engine can read old values. There is one custom slot
per account: picking a preset replaces it, and this device's cache reopens
the last custom theme when Custom is chosen again.

The value stores the seed, not the derived tokens, so the derivation can
improve without a data migration. The cost is that every client derives the
tokens itself; `src/data/custom-theme.ts` owns that math and has no DOM or
React dependency.

`CustomThemeId` in that module is the Effect Schema for the value: a strict
pattern plus range bounds. The Worker decodes theme writes against it, or
against the preset id pattern, so a malformed value or a CSS payload gets a 400. The existing plan gate still applies, so a free account gets a 403.
Clients still read an unknown or invalid value as the default theme.

## Deriving the theme

`customThemeTokens(seed, mode)` returns the base shadcn tokens for one Mode as
`#rrggbb`: page, text, card, border, input, sidebar, primary, primary text,
and destructive. The page and text take the second color's hue when there is
one, else the first color's, at a chroma set by the Page slider. Everything
else stays derived by `:root.themed` in `styles.css`, as for the presets:
popover, accent, secondary, muted text, tag fills and inks, highlights, and
the other blended accents.

- **Primary reads with its own text.** The primary fill moves the least
  lightness needed for 4.5:1 against either white or a deep shade of its hue,
  whichever needs less change. Lime keeps dark text, like Leaf; cobalt keeps
  white. `.theme-custom` opens the primary lightness clamp because the fill
  is already safe.
- **The second color** sets `--link-source` and `--accent-source`, so links
  and the quiet accent surfaces (hover, selection) take it. Without a second
  color, `.theme-custom` points links at the primary, and `:root.themed` falls
  back to primary for accent. Presets never set `--accent-source`.
- **Names.** The picker and the membership dialog name a theme from its hues,
  such as "Cobalt & Ember", never with a hex value.

## Painting and loading

`color-theme.ts` paints a custom theme by writing both Modes' tokens into one
`<style id="dotflowy-custom-theme">` element as `:root.theme-custom.theme-custom`
rules, and adding `themed theme-custom` to `<html>`. The doubled class
outranks the fixed `.theme-custom` rule wherever the element lands in `<head>`.

The no-flash script cannot run the derivation, so this device caches it:
`dotflowy:custom-theme` holds `{ id, light, dark }`, written whenever a custom
theme is saved or adopted from the account, and rewritten when the account's
theme loads and its derived colors differ, so an improved derivation reaches
the cache without the user picking again. Before first paint, the script
rebuilds the style element when the cache's id matches the saved theme, and
sets the status bar from the cached page color. Both the script and
`customThemeCssFromTokens` drop anything that is not a `#rrggbb` value, so an
edited cache cannot inject CSS.

A brand new device has no cache and shows the default theme until the account
loads, then the custom theme. Cam accepted that.

A device whose mirror is stale, because the theme changed on another device,
paints the old theme until the account loads, then switches. This is inherent
to cache-then-account loading and predates custom themes; it applies to
presets the same way.

## Picking and dragging

The picker shows in Settings → Appearance when Custom is active. Dragging a
dot paints a draft on every surface without saving. Releasing it saves once,
through `setColorTheme`, so a drag sends one account write. Arrow keys move
the focused dot and save when the key is released; the Page slider saves on
its native `change`, which fires however the drag ends. The palette swatches
set the active dot to one of the nine `--hue-*` colors and save at once.
Theme saves run one at a time in the order they were picked, because
concurrent writes can reach the account out of order and leave an older
theme saved. ⌘K "Theme: Custom" opens this picker with the last custom
theme.

Free users can preview Custom like any paid palette: the draft and preview
stay in memory, the preview box names the theme, and "Unlock themes" opens
"Make {name} yours" with checkout. Leaving Settings restores the saved theme.

## Rejected

- **A separate `appearance:custom-theme` row.** Two rows can disagree, and the
  preset row already carries the active choice across devices.
- **Several saved custom themes.** One slot is enough for now.
- **The derivation in the no-flash script.** It would duplicate the color
  math in an inline string; the device cache covers every load but the first.
- **A conventional color picker or per-token editing.** Cam rejected both as
  ugly and complex. The derivation owns contrast so the user cannot pick an
  unreadable theme.

## Checks

`src/data/custom-theme.test.ts` round-trips the stored value, rejects
malformed and out-of-range values, sweeps hue, chroma, tint, and second color
for 4.5:1 primary text, and checks that the CSS holds only hex values.
`e2e/color-themes.spec.ts` adds 12 sampled custom themes, with and without a
second color, to both real-stylesheet contrast sweeps of ADR 0082, and checks
that a saved custom theme paints before the app mounts and comes back from
the account on a device without the cache. `worker/capture-real.test.ts` checks that the Worker
rejects a free account's custom theme (403) and an out-of-range or
CSS-carrying value on any plan (400), and accepts a paid one.
