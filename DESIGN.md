---
name: Dotflowy
description: An open-source, keyboard-first outliner you own. Grayscale, one blue accent, zero gradients.
colors:
  paper-bg: "oklch(0.98 0 0)"
  surface: "oklch(0.99 0 0)"
  subtle: "oklch(0.97 0 0)"
  hairline: "oklch(0.922 0 0)"
  muted-ink: "oklch(0.556 0 0)"
  ink: "oklch(0.27 0 0)"
  ink-strong: "oklch(0.205 0 0)"
  ink-inverse: "oklch(0.985 0 0)"
  mirror-blue: "oklch(0.58 0.13 250)"
typography:
  display:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "clamp(3rem, 6vw, 3.75rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "clamp(2.25rem, 5vw, 3rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Geist Mono Variable, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.12em"
rounded:
  md: "0.5rem"
  lg: "0.625rem"
  card: "1.125rem"
  full: "9999px"
spacing:
  gutter: "1.5rem"
  section: "5rem"
components:
  button-primary:
    backgroundColor: "{colors.ink-strong}"
    textColor: "{colors.ink-inverse}"
    rounded: "{rounded.lg}"
    height: "2.75rem"
    padding: "0 1.25rem"
  button-primary-hover:
    backgroundColor: "oklch(0.205 0 0 / 0.8)"
    textColor: "{colors.ink-inverse}"
  button-outline:
    backgroundColor: "{colors.paper-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "2.75rem"
    padding: "0 1.25rem"
  chip-tag:
    backgroundColor: "oklch(0.58 0.13 250 / 0.12)"
    textColor: "{colors.mirror-blue}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.375rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "1.5rem"
---

# Design System: Dotflowy

## 1. Overview

**Creative North Star: "The Quiet Instrument"**

Dotflowy looks like a precision tool that stays out of your way. It is grayscale on purpose: paper-white surfaces, near-black ink, hairline borders, and exactly one point of color, the same blue the app uses to mark a live connection. Nothing shouts. The loudest thing on any page is the outline itself, because the content is the product. The bullet dot is the through-line, recurring as logo, marker, and structure, the way a well-made instrument repeats one shape.

The register is calm, focused, and fast. It speaks to people who already think in outlines and are done renting their second brain from a closed app, so it never explains the category or oversells. It rejects the entire vocabulary of generated SaaS marketing: gradient washes, aurora glow blurs, gradient-clipped headlines, a tracked-caps eyebrow above every section, cute illustration, and any "your AI runs your life" agent theater. When an assistant appears, it appears as a quiet muted mark, not a spectacle. Warmth comes from restraint and typography, never from decoration.

Critically, the marketing surface must not diverge from the product. The app (`src/styles.css`) has zero gradients and one functional blue; the site mirrors it exactly. If a treatment would surprise a user the moment they click "Get started," it is wrong.

**Key Characteristics:**
- Grayscale base (OKLCH chroma 0), one solid blue accent, no gradients ever.
- Geist Sans for everything readable; Geist Mono for keycaps, labels, and small product artifacts.
- Flat by default: hairline borders and tonal layering carry structure, shadows are rare.
- The bullet dot is the brand motif; the live outline is the hero.
- AI is a quiet helper, marked for provenance, never the star.

## 2. Colors

An achromatic system: every surface, text, and border is pure grayscale except a single blue accent borrowed from the app's node-mirror hue.

### Primary
- **Mirror Blue** (`oklch(0.58 0.13 250)`, brighter `oklch(0.72 0.13 250)` on dark): the only chromatic color on the page. Used solid and sparingly, on interactive text only, never on a button fill and never in a gradient: the hero accent word ("yours"), tag chips, link underlines. It is the app's `--mirror-source`, so color on the site means the same thing it means in the product.

### Neutral
- **Ink** (`oklch(0.27 0 0)`): primary body and heading text on light surfaces.
- **Ink Strong** (`oklch(0.205 0 0)`): the primary button fill and the darkest UI ink. This, not blue, is the color of a call-to-action.
- **Ink Inverse** (`oklch(0.985 0 0)`): text on Ink Strong (button labels), and text on dark surfaces.
- **Muted Ink** (`oklch(0.556 0 0)`, `oklch(0.708 0 0)` on dark): supporting copy, captions, mono labels. Verified to clear 4.5:1 on paper.
- **Hairline** (`oklch(0.922 0 0)`, `oklch(1 0 0 / 10%)` on dark): borders, dividers, section rules.
- **Paper Bg** (`oklch(0.98 0 0)`) / **Surface** (`oklch(0.99 0 0)`) / **Subtle** (`oklch(0.97 0 0)`): the near-white page, the slightly lifted card, and the recessed chip/secondary fill. On dark: `0.205 / 0.25 / 0.269`.

### Named Rules
**The One Blue Rule.** There is exactly one accent color and it lives on text, never on a button. A blue button is forbidden: the accent lightens to L0.72 in dark mode and white-on-blue fails contrast. CTAs are grayscale Ink Strong, matching the app's real buttons.

**The Mirror Rule.** The site may not introduce a color, gradient, or treatment the app doesn't have. The app is the source of truth. Tokens already match; usage must too.

## 3. Typography

**Display / Body Font:** Geist Variable (with `sans-serif` fallback)
**Label / Mono Font:** Geist Mono Variable (with `ui-monospace, monospace`)

**Character:** One family in many weights, paired on a contrast axis only with its own monospace cut. Geist Sans is clean and neutral, near-invisible so the content leads; Geist Mono signals "keyboard, command, artifact" and carries the dev-credible register (the keyminder.app reference) without a second personality.

### Hierarchy
- **Display** (600, `clamp(3rem, 6vw, 3.75rem)`, line-height 1.02, tracking -0.025em): the hero H1 only. One word ("yours") is Mirror Blue; the rest is Ink. Uses `text-wrap: balance`.
- **Headline** (600, `clamp(2.25rem, 5vw, 3rem)`, 1.1): section and closing-CTA H2s.
- **Title** (500, 1.125rem, 1.3): feature H3s and card titles.
- **Body** (400, 1.125rem / 15px, 1.6, Muted Ink): all supporting prose. Capped ~65ch via a `max-w-xl` measure. Uses `text-wrap: pretty`.
- **Label** (500, 0.75rem, tracking 0.12em, uppercase, Geist Mono): the single hero kicker, keycaps, and small artifacts.

### Named Rules
**The One Kicker Rule.** The uppercase mono kicker appears once, in the hero. An eyebrow above every section is AI grammar and is prohibited.

**The No-Em-Dash Rule.** Body copy uses periods and commas, not em-dashes. Long dashes read as machine-written prose and break the house voice.

## 4. Elevation

Flat by default. Depth comes from hairline borders and near-imperceptible tonal layering (Surface L0.99 sits on Paper L0.98), not from shadow. Shadows appear only on genuinely floating objects: the hero demo's faux window and the drag pill in the app. There is no ambient decorative shadow, and never a glow.

### Shadow Vocabulary
- **Floating panel** (`box-shadow: 0 12px 40px -12px oklch(0.2 0 0 / 0.18)`): the hero outline-demo window, to lift it off the page as a live surface. This is the only decorative shadow on the marketing page.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest; structure is a 1px Hairline border or a tonal step. If you reach for a shadow to separate two blocks, use a border instead. No aurora glow, no soft drop-shadow-plus-border ghost cards.

## 5. Components

### Buttons
- **Shape:** gently rounded (`0.625rem`, `rounded-lg`). Never pill-rounded on a rectangular button, never above ~12px.
- **Primary:** Ink Strong fill, Ink Inverse label (`bg-primary text-primary-foreground`), height 2.75rem, padding `0 1.25rem`. This is the app's real default button. It is grayscale, not blue.
- **Hover / Focus:** primary fades to 80% (`hover:bg-primary/80`); focus shows a 3px ring at `ring/50`. Active nudges down 1px (`translate-y-px`).
- **Outline / Ghost:** Outline is a Hairline border on Paper, hover fills Subtle. Ghost is transparent, hover fills Subtle. Used for the secondary "Star on GitHub" and nav actions.

### Chips (tags)
- **Style:** Mirror Blue text on a 12%-blue fill, fully rounded (`rounded-full`), mono. Used for `#tags`. The metadata chips (MIT licensed, self-hostable) are the muted variant: Muted Ink on Subtle with a Hairline border, `rounded-md`.

### Cards / Containers
- **Corner Style:** `1.125rem` (`rounded-2xl`).
- **Background:** Surface (or Card in the app), on Paper.
- **Shadow Strategy:** none at rest (see Elevation); the sole exception is the hero demo's Floating Panel shadow.
- **Border:** 1px Hairline. This carries the separation, not a shadow.
- **Internal Padding:** 1rem to 1.5rem.

### Navigation
- Sticky top bar, Paper at 80% with `backdrop-blur`, a bottom Hairline. Logo is the bullet Dot plus mono "dotflowy". Actions are Ghost buttons at `sm` size; "Sign in" drops below `sm`. Primary "Get started" is the grayscale Primary button.

### Signature: The Live Outline Demo
The REAL Dotflowy editor (`HeroOutlineEmbed`), embedded live in a Floating Panel with faux window chrome. It is the page's hero and its proof — literally the product, running an anonymous in-memory backend (`?demo=1`, no auth, no Worker), so it can never drift from the app. Every real move works: Enter-split, Tab nesting, `#tags` with color, to-dos, rich links, click-a-Dot to zoom, and the Provenance Mark on the one AI-drafted node. The iframe is client-only and lazy (a skeleton holds first paint; it fades in when the panel nears the viewport), so the "fast" promise holds. Show, don't tell: the demo is the pitch.

### Signature: The Provenance Mark
A single muted Geist-Mono-adjacent lucide `Sparkle` (`text-muted-foreground`) placed before a node's text, marking content an AI assistant created (mirrors `src/plugins/provenance`). Static, single-hued, quiet, with a "Created by [agent] · [time]" caption. It is the entire visual language of AI on this brand.

## 6. Do's and Don'ts

### Do:
- **Do** keep the surface grayscale and put the one Mirror Blue accent on text only (`oklch(0.58 0.13 250)`), sparingly.
- **Do** make CTAs Ink Strong (grayscale), matching the app's real buttons.
- **Do** let the live outline demo be the loudest thing on the page.
- **Do** use hairline borders and tonal steps for structure; keep surfaces flat at rest.
- **Do** repeat the bullet Dot as the through-line motif.
- **Do** show AI as a quiet muted `Sparkle` provenance mark; the pitch is trust, not automation.
- **Do** cap body measure at ~65ch and use `text-wrap: balance` on H1-H3.

### Don't:
- **Don't** use gradients anywhere, and never `background-clip: text` (gradient headlines). The product has zero gradients; the site must too.
- **Don't** add an ambient glow blur or aurora blob. Not gradient-drenched VC SaaS.
- **Don't** make AI the hero: no "your AI runs your outline" agent-drenched section, no sparkle-as-spectacle. The agent is a helper; its only visual is the provenance mark.
- **Don't** put a tracked-caps eyebrow above every section. One kicker, in the hero, only.
- **Don't** write salesy or cute copy, and don't use em-dashes in body text.
- **Don't** use a colored `border-left` stripe as an accent, or a 1px-border-plus-soft-wide-shadow "ghost card".
- **Don't** over-round: cards top out at ~18px, buttons at ~12px. No 24px+ rounded cards.
- **Don't** introduce any color, font, or treatment the app doesn't have. Mirror the product.
