---
"dotflowy": patch
---

Supervise the live-sync consumer so a bad inbound frame can no longer silently kill sync: the fiber now logs the failure and re-establishes (fetching a fresh snapshot) up to a bounded budget, then shows a persistent "Sync interrupted — reload" notice instead of dying quietly while the connection still looks alive.
