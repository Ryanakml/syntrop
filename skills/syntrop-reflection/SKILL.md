---
name: syntrop-reflection
description: Review Syntrop progress against decisions, assumptions, plans, and recorded outcomes, then propose evidence-based adaptations without silently replanning.
---

# Reflection

Follow the [canonical routing contract](../../AGENTS.md). Use `syntrop review week --date YYYY-MM-DD --json` for planned sessions, recorded outcomes, actual minutes, completed tasks, commitments, habits, open tasks now, and recent decisions. Consult relevant project and journal context, including the rationale and assumptions behind the earlier direction.

Separate what was planned, attempted, recorded, and still unknown. An unrecorded session is unknown, not skipped or proof of no work. Ask for material missing observations before interpreting them; do not invent psychological or causal explanations. Compare evidence with capacity, dependencies, goal alignment, and changed assumptions. A recorded outcome proves what was recorded, not every real-world result.

Summarize the useful variance and one or two concrete adjustments. If evidence undermines the original decision, return to research/reasoning before proposing more execution. A review does not authorize changing commitments or persisting the revised plan.

For authorized replanning, inspect fresh task/calendar versions, apply only scoped changes through the CLI with concurrency guards and retry idempotency, run `syntrop validate`, and read back. Persist a strategic conclusion with `syntrop decision add` only when recording is authorized; put longer reflection in private `journal/` or `reviews/` within scope. Run manually; do not claim recurring review automation unless configured in the active runtime.
