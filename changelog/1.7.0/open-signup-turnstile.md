---
"dotflowy": minor
---

Signup can now open to the public with Cloudflare Turnstile and email verification. A new `SIGNUP_OPEN` switch (fail-closed, ships unset) skips the invite requirement when set to "true"; the Turnstile captcha plugin gates signup and password reset when `TURNSTILE_SECRET_KEY` is configured; and email verification is now required, so invited users confirm their address before their first sign-in (existing accounts are grandfathered verified).
