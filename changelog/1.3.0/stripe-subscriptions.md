---
"dotflowy": minor
---

Wire Stripe subscriptions via the `@better-auth/stripe` plugin: hosted Checkout
(`subscription.upgrade()`), the webhook at `/api/auth/stripe/webhook`, and the D1
`subscription` table (migration `0006`). Entitlement reads never call Stripe —
`worker/plan.ts` resolves a user's plan from one D1 query — and the founding
50-seat cap is enforced server-side at checkout creation. Billing secrets are
optional in dev (unset = only the billing endpoints fail).
