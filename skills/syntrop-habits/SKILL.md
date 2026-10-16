---
name: syntrop-habits
description: Design, record, and review personal habits in Syntrop while distinguishing skipped occurrences from missing data.
---

# Habits

Choose a behavior and target the user can actually perform. Keep frequency and target modest enough to test. Use `syntrop habit add` for an authorized definition and `syntrop habit log` for reported occurrences. `--correct` amends an existing date; it does not add a second occurrence.

Inspect `syntrop habit history --json` for reviews. Missing dates are unknown, not automatic failures. Compare recorded behavior with the stated target, and recommend one concrete adjustment when evidence supports it. Do not turn missed habits into overdue tasks without the user's direction.
