---
"dotflowy": patch
---

Harden and unit-test the Worker's auth/identity gates: the DO tenant-isolation key (`resolveUserId`), admin allowlist, invite-code backdoor, and email shape check are now a pure, tested module; `BETTER_AUTH_SECRET` is asserted at startup (fail-closed, not silently insecure); admin access can now be pinned to a stable `user.id` (`ADMIN_USER_IDS`) instead of an unverified email; and the SSRF unfurl guard now blocks IPv4-mapped IPv6 loopback/private targets.
