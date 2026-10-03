---
"dotflowy": patch
---

Compile the experimental Apple Shortcut template from Cherri source so every action is one Shortcuts recognizes. The previous template used an unrecognized Match Text identifier and a Generate UUID action that does not exist, which made macOS show "Unknown Action" and refuse to run it. The setup questions are now bound to their parameters, and the attempt ID comes from a built-in random number. The shared shortcut still needs re-signing.
