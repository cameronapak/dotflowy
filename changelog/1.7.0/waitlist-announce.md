---
"dotflowy": minor
---

Launch-day waitlist announcement. A new admin-only `POST /api/admin/announce` endpoint (same shape and admin gate as `/api/admin/invite`) emails the "Dotflowy is open" blast to waitlist rows through the one email seam, and `bun run announce` drives it in resumable batches. A `notifiedAt` stamp on the waitlist row (migration 0009) makes the send at-most-once, so the script is safe to re-run without double-sending.
