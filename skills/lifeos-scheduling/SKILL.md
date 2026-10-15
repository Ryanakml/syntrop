---
name: lifeos-scheduling
description: Allocate LifeOS work sessions around real commitments and sustainable capacity, or help replan an overloaded calendar.
---

# Scheduling

Inspect `life week --json`, relevant tasks, dependencies, estimates, deadlines, and events. Estimate a realistic work budget after fixed commitments and buffers; a free slot is not automatically productive capacity. Prefer a ready task for the next session. Schedule blocked work later only when there is a credible path to finish its prerequisites first. Propose a small near-term schedule and explain material tradeoffs.

Use `life schedule add` or `life schedule move` only for authorized changes. Times require an explicit offset. Resolve `SCHEDULE_CONFLICT` by reconsidering the plan, not by silently moving existing events. A task deadline remains separate from its work session. Verify the resulting schedule and task due dates.
