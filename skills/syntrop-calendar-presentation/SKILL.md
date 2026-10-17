---
name: syntrop-calendar-presentation
description: Design adaptive Google Calendar and Google Tasks presentation, concise scannable titles, custom event labels, and completion reconciliation through validated Syntrop CLI contracts.
---

# Calendar & Tasks Presentation

Follow the [canonical routing contract](../../AGENTS.md) and the [Google Calendar & Tasks integration guide](../../docs/integrations/google-calendar.md). Separate intelligence from execution: you design context-appropriate presentation, visual hierarchy, and scannable copy from the user's actual workspace; the Syntrop CLI validates configuration, checks API capabilities, projects deterministic payloads, enforces ownership, and reconciles completions safely.

## 1. Inspect workspace context before designing presentation

Read current operational state (`syntrop status --json`, `syntrop week --json`, `syntrop habit list --json`) and `syntrop integration google presentation show --json`. Inspect active goals, projects, tasks, dependencies, scheduled work sessions, commitments, and habits before proposing labels, short names, or publication modes. Never hardcode generic lifestyle templates (`career`, `oss`, `learning`) when the user's actual work is research, clinical practice, engineering, teaching, or creative production.

## 2. Assign each concept to the right Google product surface

- **Work sessions & fixed commitments → Google Calendar (`Syntrop · Focus`)**: Reserved time blocks with start/end timestamps (`busy`). Keep Calendar focused on time allocation.
- **Actionable tasks → Google Tasks (`Syntrop · Tasks`)**: Completable deliverables (`status: needsAction | completed`). Default to `mode: actionable` (ready tasks with scheduled sessions, near-term deadlines, or active status) so blocked tasks and distant backlog items do not clutter the list.
- **Daily & weekly habits → Google Tasks (`Syntrop · Habits`, `mode: tasks`)**: Individually completable occurrences over a bounded rolling horizon (default 14 days). Use Calendar `flexible` or `timed` habit modes only when the user explicitly wants visual calendar blocks instead of checkboxes.
- **Deadlines**: When actionable tasks are projected to Google Tasks, keep `includeDeadlines: false` on Calendar unless the user explicitly wants separate all-day deadline banners.

## 3. Design concise titles and a coherent visual hierarchy

- **Short titles (`22–42` chars ideal)**: Define project `shortName` (`<= 30` chars, e.g. `Career`, `OSS`, `Editor`) and task `shortTitle` (`<= 80` chars, e.g. `Publish Resume & Astro Site`) so mobile and week-view blocks remain scannable (`Career · Publish Resume & Astro Site`). Keep long command flags, file paths, and acceptance criteria in task notes or event descriptions.
- **Focused color system (`4–6` active labels)**: Define domain-specific labels in `presentation.labels` with hex `#RRGGBB` colors and optional `colorId` fallbacks. Map projects, commitments, and habits to those label keys.
- **Privacy boundary**: Respect `titleMode: redacted` until the user explicitly opts into `titles`.

## 4. Respect provider capability boundaries

- **Google Tasks due dates are date-only**: The public Google Tasks API stores `due` as an RFC 3339 date (`YYYY-MM-DDT00:00:00.000Z`) and discards time-of-day. Represent exact work-session times on Google Calendar and scheduled action dates on Google Tasks.
- **Calendar custom event labels (`labelProperties.eventLabels` + `eventLabelId`)**: Syntrop syncs custom labels with `eventLabelVersion=1` when supported by the Google Calendar endpoint and automatically falls back to standard `colorId` palette entries when custom labels are unavailable. Report the active mode from `integration google status` or sync output honestly.

## 5. Apply, sync, migrate, and reconcile safely

Persist presentation changes via `syntrop integration google presentation apply --json-body '...'`, configure task policy with `integration google tasks configure`, and opt habits into tasks mode with `integration google habit ID --mode tasks --start-date YYYY-MM-DD`. Always preview (`integration google preview` or `migrate --dry-run`) before mutating Google state unless standing auto-sync authorization (`--auto-sync on`) has been explicitly granted for the workspace. Reconcile completed Google Tasks and habit occurrences back into Syntrop via `integration google reconcile` (`--dry-run` or `--approve HASH` / `--auto`), preserving local task prerequisite rules and timezone-safe habit occurrence dates.
