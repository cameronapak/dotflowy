# Product

## Register

brand

> This repo holds two surfaces. The **landing page** (`landing/`, apex `dotflowy.com`)
> is the active design surface and is **brand** register (design IS the product) — that's
> what `register: brand` above governs. The **app** (`src/`, `app.dotflowy.com`) is a
> **product**-register surface. When a task targets the app, treat it as `product`.

## Users

**Primary — ownership-driven outliner power users.** People who think in nested
bullets, type fast, and live in the keyboard. They came from Workflowy, Roam, or
Reflect and hit the wall: *this is closed, my data is trapped, and I can't change it.*
Also the crowd who tried Obsidian for this and bounced — they wanted an outliner and
got a document editor with too much friction. The shared pain isn't the app they left;
it's **renting their second brain from a closed vendor.**

**Secondary / emerging — AI power users.** People who want an agent to help with their
outline (MCP): capture, reorganize, plan the day. **AI is a helper here, never the star.**
The honest, on-brand angle is *provenance, not power*: nodes an agent creates wear a quiet
muted sparkle mark (`src/plugins/provenance`), so you can always tell what you wrote from
what the assistant added. That trust signal — "you stay the author" — is the pitch, not
"your AI runs your outline." Treat AI as one calm capability alongside daily notes and
tags, distinguished by honesty, not hype.

**Context of use (app surface).** Mid-thought, mid-task, often daily. Fast capture,
zoom to focus one branch, keyboard through everything. The site's job is to convert;
the app's job is to disappear.

## Product Purpose

Dotflowy is an **open-source, real-time-synced infinite outliner you actually own** —
Workflowy's speed, with the ownership and extensibility it structurally can't offer.
Free and self-hostable forever; a hosted Pro tier is coming (currently beta).

The landing page's job: convert outliner-native people who want ownership + speed, with
the **live product demo as the pitch** — not a sales deck. Two differentiators carry the
"better than, not a clone of" weight:

1. **You own it** — open source, exportable, no lock-in; extensible with plugins (the
   Obsidian promise without the document-model friction).
2. **It's honestly agent-assisted** — an agent can help over MCP, and everything it touches
   is *marked*, so you stay the author. Not "your AI runs your outline"; "AI helps, you
   own the result." The differentiation is trust, not automation.

Success = self-host adoption + Pro signups + GitHub stars, achieved **without ever
feeling like a pitch.**

## Brand Personality

**Calm. Focused. Fast.** (Fast in the literal sense — instant, synced across devices in
real time.)

Voice: confident and understated, speaking to people who already know what an outliner
is. It does **not** explain the category, oversell, or get cute. Emotional goal: relief
and control ("finally, one I own and can shape"), plus one quiet *whoa* at the
agent-native moment. Restraint reads as respect for the reader's time.

## Anti-references

- **Not a sales pitch.** No hype, no fake urgency, no "revolutionize your productivity,"
  no metric-brag hero. If it feels like we're selling, it's wrong.
- **Not cute.** No mascots, doodles, whimsy, or playful copy.
- **Not generic-to-Workflowy.** Better *than*, never a clone *of*. Avoid the
  feature-comparison-war framing that fights on the incumbent's turf.
- **Not gradient-drenched VC SaaS**, and **not a cold dev-tool terminal aesthetic** either.
- **AI is not the hero.** No "your AI runs your life" agent-drenched section, no glow, no
  sparkle-as-spectacle. The agent is a quiet helper; its only visual is the provenance mark.
- Reference lane (the *feel* to match): Linear's restraint, shadcn/ui's component
  discipline, keyminder.app's clarity-over-flourish (mono for commands, generous
  whitespace, dev-credible), and the plain simplicity of Workflowy, writeatlas.app,
  and orchid.ai (its clarity, not its motion).

## Design Principles

1. **Show, don't tell.** The live outline demo is the pitch. The product sells itself;
   the copy gets out of the way.
2. **Speak to insiders.** Assume outliner fluency. Confidence over explanation — never
   argue that outlining is good.
3. **Ownership is the throughline.** Every claim ladders back to *it's yours* — to own,
   to export, to extend.
4. **Restraint is the brand.** Simplicity is a feature. The live outline demo is the
   loudest thing on the page; everything else stays quiet. One solid accent (mirror-blue),
   used only as the app uses it — sparing and functional, never a gradient. When in doubt,
   remove.
5. **Practice what you preach.** A fast, keyboard-first, synced product deserves a site
   that is fast, keyboard-referencing, and never busy.
6. **Mirror the product, don't invent a brand.** HARD CONSTRAINT. The landing must not
   diverge from the app's real visual system (`src/styles.css`): grayscale base, Geist,
   the two mirror hues (`--mirror-source` blue / `--mirror-instance` purple) used only as
   sparing, *solid, functional* accents — never a gradient. The app has zero gradients and
   zero `background-clip: text`; the landing must too. Tokens already match; usage must too.

## Accessibility & Inclusion

- **WCAG AA**: body text ≥ 4.5:1, large text ≥ 3:1. Watch muted-gray-on-tinted body copy.
- **Reduced motion** respected (already honored in-app and in the hero caret).
- **Keyboard-navigable** throughout — non-negotiable for a keyboard-first product.
- **Dark mode is first-class** (the app ships it; the marketing tokens mirror it).
