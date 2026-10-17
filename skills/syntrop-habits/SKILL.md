---
name: syntrop-habits
description: Add, record, design, or review Syntrop habits directly when authorized, while distinguishing skipped occurrences from missing data.
---

# Habits

Follow the [canonical routing contract](../../AGENTS.md). Preserve the fast path: “add a daily reading habit of 20 minutes” is clear authorized creation. Inspect relevant existing habits, use `syntrop habit add`, validate, read back, and report briefly. Do not require strategic research without a concrete uncertainty. In mixed requests, handle this habit independently; it grants no permission to persist career projects or schedule other ambitions.

Choose a behavior the user can perform. Encode units in the name (for example, “Read 20 minutes”) and use daily frequency with target 1 for one daily occurrence; `--target` counts occurrences, not minutes. For open-ended behavior design, keep the proposed target modest enough to test; a proposal is not authorization to create it.

Use `syntrop habit log` only for reported occurrences. `--correct` amends an existing date, not a second occurrence; inspect its version and use the supported concurrency guard. Use idempotency for retries.

Inspect `syntrop habit history ID --json` for reviews. Missing dates are unknown, not automatic failures. Compare recorded behavior to the target and recommend one adjustment when evidence supports it. Do not turn missed habits into overdue tasks without user direction. After changes, run `syntrop validate` and read back the affected records.


Google display is a separate explicit opt-in via `integration google habit`; creating a local habit never publishes it. Use the [integration guide](../../docs/integrations/google-calendar.md) and [calendar-presentation skill](../syntrop-calendar-presentation/SKILL.md), and preview before sync. Prefer `--mode tasks --start-date YYYY-MM-DD [--horizon-days N]` so daily and weekly habits appear as individually completable Google Tasks in `Syntrop · Habits` over a bounded rolling window; `integration google reconcile` records completed habit tasks into `habit_occurrences` using the mapped local occurrence date (preserving timezone accuracy even when checked after midnight). Calendar `flexible` mode remains available as a transparent recurring reminder with an explicit anchor date, and `timed` mode requires chosen time and duration (plus weekdays for weekly habits); Calendar reminders never write `habit log`. Deactivation or removal stops future projections on the next approved sync.
