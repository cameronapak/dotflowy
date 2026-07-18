---
"dotflowy": patch
---

Opening or filing into a daily note is more reliable: creating today's note now waits for the write to durably land before navigating, so a failed save shows a clear message instead of dropping you on a note that vanishes, and "Send to Today" no longer misfiles a node when today's note was just created. Quick-add now keeps your draft and shows an error if today's note can't be opened (instead of silently filing the capture at the top level), and hitting the free-plan limit while opening a daily note shows only the upgrade notice, not a second generic error.
