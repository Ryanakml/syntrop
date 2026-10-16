# Syntrop CLI Command Reference

This document provides a comprehensive reference for all commands, flags, arguments, exit codes, and JSON schemas supported by the Syntrop CLI (`syntrop`, alias `syn`, `life`, or `node src/cli.ts`).

---

## 1. Global Options & Conventions

Every command supports the following global options:

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--workspace PATH` | String | Path to the private workspace. Defaults to `SYNTROP_WORKSPACE` or `LIFE_WORKSPACE` env var, or `~/.syntrop`. Cannot point inside the source repository. |
| `--json` | Flag | Emits machine-readable JSON to `stdout`. Disables human-formatted terminal text. |
| `--idempotency-key KEY` | String | Uniquely identifies a mutation request. Retrying with the same key returns the identical response without duplicate side effects. |
| `--expected-version N` | Integer | Optimistic concurrency guard. Mutation fails if the record's current version does not match `N`. |
| `--help` | Flag | Displays the CLI usage manual. |

### Semantic Exit Codes
- `0`: Success.
- `2`: Validation error, missing required arguments, or invalid syntax.
- `3`: Business rule conflict (e.g., schedule time overlap, DAG dependency cycle, uncompleted prerequisites).
- `4`: Workspace missing, corruption, or storage error.

### Error Envelope (`--json`)
When an error occurs with `--json`, error information is printed to `stderr`:
```json
{
  "error": {
    "code": "VALIDATION | NOT_FOUND | CONFLICT | WORKSPACE",
    "message": "Human-readable explanation"
  }
}
```

---

## 2. Workspace Management

### `syntrop init [--timezone IANA]`
Initializes a new private workspace.
- Defaults to detected system timezone if `--timezone` is omitted.
- Generates `config.json` (mode 0600) and `data/life.db` (mode 0600).
- Rejects paths inside the source repository or existing nonempty directories.

### `syntrop doctor`
Performs an instant operational and integrity audit of the current workspace.
- Returns Node version, workspace path, timezone, SQLite validation status, and entity counts.
- Exits with `4` if validation fails.

### `syntrop validate`
Runs SQLite integrity checks, foreign key checks, DAG cycle verification, interval consistency, and completion status validation.

### `syntrop backup --to DIRECTORY`
Creates a consistent backup bundle at `DIRECTORY`. Uses Node 24 native SQLite `backup` API to ensure ACID consistency without file locking issues.

### `syntrop restore --from DIRECTORY --workspace NEW_PATH [--timezone IANA]`
Validates and restores a backup bundle into `NEW_PATH`. Refuses to overwrite an existing directory.

### `syntrop export --to FILE`
Exports a portable, JSON snapshot of all database records and configuration. Refuses to overwrite an existing file.

---

## 3. Goals & Projects

### `syntrop goal add --title TEXT`
Creates a new high-level goal.
- Status defaults to `active`.

### `syntrop goal list` / `syntrop goal show ID`
Lists all goals or retrieves one goal by ID.

### `syntrop goal update ID [--title TEXT] [--status active|paused|done|cancelled]`
Updates a goal. Increments the goal's version number.

### `syntrop project add --title TEXT [--goal ID]`
Creates a project optionally linked to a parent goal.

### `syntrop project list` / `syntrop project show ID`
Lists all projects or retrieves one by ID.

### `syntrop project update ID [--title TEXT] [--status active|paused|done|cancelled]`
Updates a project.
- Transitioning to `done` requires all linked tasks to be `done` or `cancelled`.
- **Exception Override**: To force complete a project with open tasks:
  ```sh
  syntrop project update ID --status done --allow-open-tasks --reason "Scope deferred to Q2"
  ```
- Pausing or cancelling a project automatically cancels its active/scheduled work sessions.

---

## 4. Tasks & DAG Dependencies

### `syntrop task add --title TEXT [--project ID] [--status STATUS] [--priority 1..5] [--depends-on ID1,ID2]`
Creates a new task.
- `status`: `inbox` (default), `todo`, `in_progress`, `waiting`, `done`, `cancelled`.
- `priority`: `1` (highest) to `5` (lowest). Default: `3`.
- `--depends-on`: Comma-separated prerequisite task IDs. Cycle detection runs before commit.

### `syntrop task list [--project ID]`
Lists tasks, optionally filtered by project.

### `syntrop task next`
Returns the next **actionable, ready task**, or null if none qualifies:
- Task status is `inbox`, `todo`, or `in_progress`.
- Linked project (if any) is active.
- **All prerequisite tasks are completed (`done`)**.

### `syntrop task done ID`
Marks a task as completed.
- Rejects completion if prerequisite tasks remain uncompleted.
- **Exception Override**:
  ```sh
  syntrop task done ID --allow-blocked --reason "Prerequisite verified externally"
  ```
- Completing a task automatically cancels any future work sessions linked to it.

### `syntrop task cancel ID`
Cancels a task and cancels its future work sessions. Preserves history.

### `syntrop task depends add TASK_ID PREREQUISITE_ID`
Adds a dependency edge. Enforces DAG invariants; rejects circular references with exit code `3`.

### `syntrop task depends remove TASK_ID PREREQUISITE_ID`
Removes a dependency edge.

---

## 5. Work Sessions & Calendar

### `syntrop schedule add --task ID --start ISO_OFFSET --end ISO_OFFSET`

The engine checks task existence, project lifecycle, and interval conflicts. It permits blocked future work; the calling agent must inspect prerequisites, authorization, estimates, and human capacity before scheduling. Cognitive readiness labels in `AGENTS.md` are not CLI statuses.
Schedules a planned work session for a task.
- Timestamps require explicit ISO 8601 offsets (e.g. `2026-10-15T09:00+07:00`).
- Rejects temporal overlaps `[start, end)` against existing sessions and calendar events.

### `syntrop schedule record ID --outcome completed|skipped --actual-minutes N [--note TEXT]`
Records the observed outcome of a completed past session.
- `completed` requires `--actual-minutes > 0`.
- `skipped` requires `--actual-minutes 0`.
- To correct a previous record: pass `--correct --expected-version N`.

### `syntrop schedule cancel ID`
Cancels a scheduled session, preserving the historical record while releasing the time block.

### `syntrop calendar add --title TEXT --start ISO_OFFSET --end ISO_OFFSET`
Adds a calendar event commitment (e.g., meeting, doctor visit).
- Rejects overlaps against other active events or work sessions.

### `syntrop calendar cancel ID`
Cancels an event and frees the reserved interval.

---

## 6. Habits

### `syntrop habit add --name TEXT [--frequency daily|weekly] [--target N]`
Defines a habit. Frequency: `daily` (default) or `weekly`. Default target: `1`.

### `syntrop habit log ID --date YYYY-MM-DD --outcome completed|skipped [--note TEXT]`
Logs an occurrence on a logical date.
- Multiple occurrences on the same date are rejected unless `--correct` is passed.

### `syntrop habit history ID`
Displays recorded occurrences and outcomes for a habit.

---

## 7. Strategic Decisions

### `syntrop decision add --title TEXT --rationale TEXT [--project ID] [--source-url URL]`
Records an architectural or strategic decision.
- Committed atomically into SQLite.
- Stores title, rationale, project connection, and source reference.

### `syntrop decision list` / `syntrop decision show ID`
Lists recorded decisions or retrieves detailed rationale.

---

## 8. Views & Weekly Review

### `syntrop today` / `syntrop tomorrow` / `syntrop week [--date YYYY-MM-DD] [--write]`
Generates an operational agenda:
- Shows scheduled work sessions, calendar events, active habits, and tasks due in the window.
- `--write` compiles Markdown views safely into `views/generated/` (never overwrites handwritten context).

### `syntrop review week [--date YYYY-MM-DD] [--json]`
Generates a structured weekly reflection packet:
- Analyzes planned vs actual session minutes.
- Separates recorded outcomes from unrecorded past sessions (marked as `unknown`).
- Summarizes completed tasks, active habits, and recent decisions.
