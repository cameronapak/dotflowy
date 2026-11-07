---
"dotflowy": patch
---

Fix multi-paragraph paste on upgraded sync: send a small change-ops delta instead of a full-outline restore that hit "Body too large", and keep pasted sibling order when a corrupted sibling-chain fan would otherwise scramble orphans after refresh.
