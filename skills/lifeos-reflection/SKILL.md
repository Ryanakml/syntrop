---
name: lifeos-reflection
description: Run an evidence-based LifeOS weekly review and recommend adaptations to priorities, commitments, and habits.
---

# Reflection

Use `life review week --date YYYY-MM-DD --json` for planned sessions, recorded outcomes, actual minutes, completed tasks, commitments, habits, open tasks now, and recent decisions. Consult relevant project and journal context. An unrecorded session means unknown, not skipped; ask what happened before interpreting it. Compare observed work with the earlier plan, blockers, capacity, goal alignment, and changed assumptions.

Summarize what changed, what did not work, whether earlier assumptions still hold, and one or two concrete adjustments. Separate verified outcomes from missing tracking. For an authorized replan, inspect fresh calendar and task versions, apply the specific changes with the CLI, then run `life validate` and read back the new state. Record an approved strategic conclusion with `life decision add` and longer reflection in `journal/` or `reviews/`. Do not silently alter commitments. Run manually; do not claim recurring review automation is active unless configured in the current agent runtime.
