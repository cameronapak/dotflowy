# Dotflowy — Product Marketing Context

Context file for marketing work (taglines, copy, landing pages, launch posts).
Read this before applying marketing skills. Update it when positioning decisions change.

Last updated: 2026-07-14

## What Dotflowy is

A calm, fast outliner (nested bullets) that lives at app.dotflowy.com. Local-feeling,
real-time synced, extensible via compiled-in plugins (daily notes, tags, todos, rich
links, highlights, spoilers, Bible references), and **agent-native**: AI agents can read
and write the user's outline over MCP with OAuth, provenance-stamped edits, and
spoiler-redacted egress.

It is more than "an outliner" and more than "an open source Workflowy alternative" —
those are categories and channels, not the pitch.

## The job to be done

Nobody hires Dotflowy to outline. They hire it to **free up working memory**.

The mental model (from user conversations): the mind is a workbench with ~8 slots.
People bombarded with ideas all day run out of slots. Scratch pads lose the thoughts.
Dotflowy externalizes them so the workbench clears — and lets thoughts be manipulated
in a way that feels almost physical.

### The three stages (pitch structure — walk them in order)

1. **Capture** — a thought arrives when you can't deal with it. Quick-add gets it out
   of your head without even showing you the page (ADR 0049). Loss aversion is the
   emotional driver: a lost thought hurts.
2. **Retrieve** — find it when it matters. Filters, saved queries, Cmd+K, backlinks.
3. **Shape** — manipulate ideas almost physically. Drag, indent, zoom, mirror, split.

## Audience

**Primary (next 6 months): overwhelmed thinkers.** People bombarded with ideas —
ADHD-adjacent, scratch-pad users, "too many tabs open in my head." Target the moment
of pain (the thought that just evaporated), not the tool comparison.

Secondary audiences, in order:
- **AI power users** — "an outliner your agents can read and write" is the genuinely
  novel claim Workflowy can't make. This is the HN/X spread story, not the homepage.
- **Workflowy refugees** — reach them via search/comparison channels only (see below).
  Status-quo bias means "better Workflowy" loses head-on; don't pitch switching.

## Tagline (status: working candidate, not locked)

Front-runner pair:

> **Tagline:** *Room to think.*
> **Subheadline:** *Get everything out of your head, shape it when you're ready, and
> find it when it matters.*

The subheadline walks the three stages verbatim. The product screenshot/demo is the
third element of the hero — visual appearance drives continued use, so show it,
don't describe it.

Shortlist still alive (by angle):
- Workbench/head-space: *Free up your head.* / *Your head is for thinking, not storing.*
  (GTD-adjacent frame — proven, phrase it our own way)
- Loss-aversion capture: *Catch the thought before it's gone.* / *Every thought lands somewhere.*
- Physical manipulation (most differentiated): *Thoughts you can hold.* / *Think with your hands.*

Rejected framings:
- Category-first ("A beautiful, extensible Markdown outliner…") — invites tool
  comparison, gets curiosity from people with existing tools, not switching.
- "Give your thoughts a home" — storage promise, not relief; Evernote-shaped.
- "Write freely. Structure naturally." — any editor could claim it.

## Positioning rules

- **Job-first, never category-first.** Lead with relief for the bombarded mind, not
  "outliner" or feature lists.
- **Open source is a channel, not the identity.** Use "open source Workflowy
  alternative" where people search for exactly that (Reddit, HN, alternativeto.net,
  comparison SEO). Keep it out of the hero and brand pitch.
- **Agent-native MCP is the novelty wedge** for the tech audience — a claim
  incumbents can't make. Separate story, separate channel.
- **Show the product early.** Beauty drives retention; the calm grayscale editor is
  itself an argument.

## Differentiators (true, verifiable)

- Quick capture without context-switching (quick-add: `q`, mobile FAB, Enter-and-done)
- Agent-native: MCP server with OAuth, per-user data isolation, provenance-marked
  agent edits, spoilers redacted from agent context
- Real-time sync (per-user Durable Object), local-app feel, works as a static SPA
- Extensible plugin architecture; markdown-native (copy/paste round-trips)
- Daily notes, mirrors, node links + backlinks, saved filters, spotlight focus mode
- Calm, keyboard-first design; virtualized so huge outlines stay fast

## Pricing (context, not messaging yet)

Invite-gated alpha → beta. Paid SKUs are Stripe subscriptions including a $99
founding tier (3-year interval, auto-renews year 3 — checkout copy must say so;
50-seat cap). Free tier = no subscription row. Pricing surface/messaging TBD (#171).

## Voice

- Calm, direct, human. No hype, no AI-isms, no exclamation-mark cheer.
- Founder: Cameron Pak. Faith is central to Cam and belongs in the **founder story**
  (about page, interviews) — not woven into product marketing for now. The Bible
  reference plugin is a genuine feature and a possible future bridge to the faith
  community (e.g. via faith.tools); deliberately deferred, revisit later.
- Accessibility matters: short paragraphs, scannable structure — the audience
  overlaps heavily with people for whom walls of text are hostile.

## Social proof (current state)

Alpha users' spontaneous praise: **"beautiful"** and **"fast."** Real and usable —
lead-worthy for the visual/retention argument — but it's praise for the *product*,
not the *job*. Nobody has yet said "my head is quieter." Actively prompt alpha users
for job-language quotes ("what changed about how you capture/think?") before launch
copy is written; a quote about relief outweighs ten about polish.

## Channels

- Landing site: dotflowy.com (live — hero + waitlist form). App: app.dotflowy.com.
- Waitlist → invite-code flow exists end-to-end.
- Comparison/OSS channels: Reddit, HN, alternativeto (category framing OK here only).
- AI/agent story: HN, X, MCP ecosystem directories.
- Changelog: GitHub Releases (public, Atom feed) + in-app "What's new".

## Open questions

- Final tagline decision (test the shortlist against real visitors)
- Pricing page messaging (#171) — founding-tier framing, "communicative semver" of value
- Whether/when to build the faith-community bridge (Bible plugin story)

## Resolved

- Repo is public (confirmed 2026-07-14) — OSS channels are usable now.
