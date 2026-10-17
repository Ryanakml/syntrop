---
name: syntrop-scheduling
description: Allocate authorized Syntrop work sessions around prerequisites, deadlines, real commitments, and sustainable capacity; replan only within granted scope.
---

# Scheduling

Follow the [canonical routing contract](../../AGENTS.md). A plan is not automatically authorized or executable. Inspect `syntrop week --json`, relevant task/project state, prerequisites, estimates, deadlines, and calendar events for the requested period. Read current versions before changing records. Separate task deadlines from work sessions.

Estimate a realistic budget after fixed commitments, energy, buffers, and competing priorities; free time is only an upper bound. Prefer ready tasks now. Do not schedule blocked work as ready merely because the time is free. Future blocked work requires a credible prerequisite completion checkpoint and an explicit contingency; the CLI permits this but does not prove readiness. There is no tentative-session state: keep tentative suggestions in the proposal until authorized.

If a direction still needs evidence or a user-owned decision, route upstream rather than allocating speculative execution. Propose a small near-term schedule, not a detailed calendar for distant uncertainties. An explicit deadline request alone does not authorize reserving time.

Use `syntrop schedule add` or `syntrop schedule move` only for authorized changes, with explicit timestamp offsets. Resolve `SCHEDULE_CONFLICT` by reporting the conflict and choosing a permitted alternative or proposing one; never silently move existing commitments. Use `calendar cancel` for cancelled events. Respect recorded session history.

Use idempotency on retries and expected versions on supported updates. Run `syntrop validate`, read back the schedule and task due dates, and report what changed versus what remains proposed. A successful overlap check does not establish human capacity or strategic suitability.


For explicitly requested Google publication, follow the [integration guide](../../docs/integrations/google-calendar.md) and [calendar-presentation skill](../syntrop-calendar-presentation/SKILL.md). Read `integration google status`, inspect local records, run the online preview for the requested date window, review drift and safe titles, then sync with `--approve HASH` (or `--auto` when standing auto-sync authorization has been explicitly enabled for the workspace). Google Calendar receives scheduled work sessions and commitments (`Syntrop · Focus`), while Google Tasks receives actionable tasks (`Syntrop · Tasks`) and habit occurrences (`Syntrop · Habits`). Use `integration google reconcile` to reconcile completed Google Tasks and habit occurrences back into Syntrop through normal prerequisite and lifecycle checks. Stable event/task IDs and ETags replace core-only retry/version flags for these integration operations.

When authorized, `integration google availability --calendars ID,ID --start ISO_OFFSET --end ISO_OFFSET` reads external busy intervals with the optional scope. Exclude Syntrop projection calendars; do not treat their mirrored sessions as separate external conflicts. Unavailable Google access means external availability is unknown, not empty. Never move commitments automatically in response.
