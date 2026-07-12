# Dotflowy Privacy Policy

**Effective date:** July 11, 2026

Dotflowy is operated by **FAITH TOOLS SOFTWARE SOLUTIONS, LLC**, an Oklahoma limited liability company. This policy says exactly what data we handle, where it lives, who can see it, and what we will never do with it. We'd rather over-disclose than hide anything.

**The short version:**

- Your notes live in your own isolated database, encrypted at rest and in transit.
- No analytics, no ads, no trackers. We never sell your data or use it to train AI models.
- Your notes are isolated from **other users** — but they are not end-to-end encrypted, so we're not going to pretend we couldn't access them. We don't, outside the narrow cases listed below.
- You can export everything anytime, and delete your account yourself, in the app.

## What we collect

**Account data.** Your email address and a hashed password (we can't read your password). If you sign in with Google, we receive your name, email address, and profile picture from Google instead. During beta, the invite code you signed up with.

**Your notes.** The outline you write is the product — we store it so we can sync and display it. That's the only reason.

**Billing data.** Handled by Stripe. We store your subscription status and plan; Stripe holds your card details. We never see your card number.

**Waitlist.** If you join the waitlist, we store the email you submitted, only to send you an invite.

**Operational logs.** Cloudflare, our hosting provider, processes every request and may transiently log IP addresses and request metadata for security and operations. We don't build profiles from logs.

**What we don't collect:** no third-party analytics, no advertising trackers, no session recording, no fingerprinting. Nothing watches how you use the app. If we ever add analytics — even a privacy-respecting kind — we'll update this policy first, and it will say so plainly.

## Where your data lives

Your outline is stored in a **per-user database** (a Cloudflare Durable Object with its own SQLite database) — one per account, keyed to your account alone. Account, waitlist, and subscription records live in Cloudflare D1. All of it is encrypted at rest and all traffic is encrypted in transit (TLS).

## Who can see your notes — the honest part

Per-user isolation means **other users can never reach your data**: every request is authenticated and routed only to your own database.

It does **not** mean we can't. Your notes are not end-to-end encrypted — the service has to read them to sync, search, and render them. So the truthful claim is: **we can technically access your data, and we don't**, except when:

- you explicitly ask us to (e.g., support or a data-recovery request);
- we're legally required to;
- it's strictly necessary to debug a fault affecting your account, in the narrowest scope that fixes it.

Any privacy policy that tells you the operator of a synced, non-E2E-encrypted notes app "cannot" access your data is lying to you. We won't.

## Third parties we use

We share data with exactly these processors, for exactly these purposes:

- **Cloudflare** — hosts everything: the app, your outline database, account records, and transactional email delivery (e.g., password resets).
- **Stripe** — payment processing and subscription state.
- **Google** — only if you use Google sign-in (we receive your basic profile), and one small thing worth disclosing: when a note contains a web link, **your browser** loads that site's icon from Google's favicon service, so Google sees the link's domain (not the full URL, and never your note's content).

Two more behaviors in the spirit of full disclosure:

- **Link previews.** When you paste a URL, our server fetches that page once to grab its title. Fetched titles are cached for up to 24 hours and that cache is shared across users — it holds only the public page title, keyed by the URL.
- **AI agents (MCP).** No agent can touch your outline unless **you** authorize it via OAuth. An agent you authorize can read and edit your notes; you can revoke its access at any time. Text you mark as a spoiler (`||like this||`) is redacted from what agents read — that's context hygiene to keep flagged text out of an AI's view, **not** a security boundary (an agent you've authorized acts with your keys).

We never sell your data, share it for advertising, or use it to train AI models. There are no other recipients.

## Cookies

One cookie: your login session. No tracking cookies. Preferences like theme and view settings are stored locally in your browser.

## Data durability

Your outline database has an automatic **30-day point-in-time recovery window** — if something is accidentally lost, we can restore it to any point in the last 30 days. We do our best, but no system is loss-proof, so export is always one click away: your full outline in OPML or Markdown, free, on every plan.

## Deletion and retention

You can **delete your account yourself, in the app**. Deletion removes your account record and your entire outline. Deleted data can persist in the recovery window described above for up to 30 days, after which it's gone for good. To be removed from the waitlist, email us and we'll delete your address.

## Your rights

Regardless of where you live, you can: **access** your data (it's your outline — plus email us for anything else we hold), **export** it (in-app, anytime), **correct** it (edit your notes and account), and **delete** it (in-app). Email us for anything this list doesn't cover and we'll honor any request we reasonably can.

## Children

Dotflowy isn't for children under 13, and we don't knowingly collect their data. If you believe a child under 13 has an account, email us and we'll delete it.

## Changes to this policy

If this policy changes, we'll update this page and, for material changes, notify you by email or in the app before they take effect. The current version always lives at this page.

## Contact

**FAITH TOOLS SOFTWARE SOLUTIONS, LLC** — Edmond, Oklahoma, USA
[support@dotflowy.com](mailto:support@dotflowy.com)
