# Google Calendar & Tasks integration (beta)

Syntrop keeps operational state locally in SQLite and publishes an approved projection into Google Calendar (**Syntrop · Focus** and **Syntrop · Habits** calendars) and native Google Tasks (**Syntrop · Tasks** and **Syntrop · Habits** task lists). Core task, scheduling, habit, review, backup, and validation commands work offline. Calendar publication is one way (`Syntrop -> Google Calendar`), while verified completion signals on workspace-owned Google Tasks and habit occurrences can be reconciled back into Syntrop via `integration google reconcile`.

**Verification has distinct stages:** a Desktop client is configured, local OAuth credentials are present (`calendar.app.created` and `tasks`), a real Google API request succeeds, remote synchronization/reconciliation is verified by API read-back, and visual rendering is inspected in the Google Calendar/Tasks UI. `integration google status` and `integration google diagnose` establish local configuration and cached scope state; they do not independently prove current remote access or account email.

## Quick start

Use Node 24 and run `npm ci` in the repository. Examples use `node src/cli.ts`; an installed `syntrop` command is equivalent. Add `--workspace /absolute/path` before `integration` to select a workspace other than `~/.syntrop`.

1. If Google Cloud setup is already complete, reuse the existing **Desktop app** JSON; do not recreate the project or OAuth client. Enable both **Google Calendar API** and **Google Tasks API** in that project. Keep the client JSON outside the repository and Syntrop workspace.
2. Register the local Desktop client file (if not already registered), then connect through your normal browser to grant both Calendar (`calendar.app.created`) and Tasks (`tasks`) permissions:

   ```sh
   chmod 600 /absolute/path/downloaded-desktop-client.json
   node src/cli.ts integration google setup --client /absolute/path/downloaded-desktop-client.json
   node src/cli.ts integration google connect
   node src/cli.ts integration google status
   ```

   If you previously connected in v0.3.0 with only `calendar.app.created`, running `connect` uses incremental authorization (`include_granted_scopes=true`) to add `https://www.googleapis.com/auth/tasks` while preserving your existing refresh token and managed calendar mappings.
3. Configure presentation, native Google Tasks projection, and daily/weekly habit checkboxes:

   ```sh
   node src/cli.ts integration google configure --title-mode titles --tasks-enabled true --tasks-mode actionable
   node src/cli.ts integration google habit --id HABIT_ID --mode tasks --start-date 2026-10-17 --horizon-days 14
   node src/cli.ts integration google presentation --file /absolute/path/presentation.json
   ```

   Titles are redacted by default; `--title-mode titles` enables readable project/task/habit names. `--presentation FILE` lets you or your AI agent define custom HEX color labels (`#RRGGBB`), concise project `shortName` prefixes, and concise task `shortTitle` overrides so narrow weekly calendar columns remain clean without truncating full local task titles.
4. Preview the combined Calendar and Tasks plan (1–90 days; default today through six days later):

   ```sh
   node src/cli.ts --json integration google preview --from 2026-10-17 --through 2026-10-23
   ```

5. Review the exact Calendar events, custom labels, native Google Tasks, habit occurrences, and conflicts. Then apply with the returned approval hash:

   ```sh
   node src/cli.ts --json integration google sync --from 2026-10-17 --through 2026-10-23 --approve PLAN_HASH
   ```

6. When you check off a task or daily habit in Google Calendar (web/mobile) or Google Tasks, reconcile verified completions back into Syntrop:

   ```sh
   node src/cli.ts --json integration google reconcile --preview
   node src/cli.ts --json integration google reconcile --approve RECONCILE_HASH
   ```

## Upgrading an existing v0.3.0 workspace (`migrate`)

If you already published work sessions, commitments, and recurring Calendar habit reminders in v0.3.0, do **not** delete your managed calendars or reset `~/.syntrop-google`. Instead:

1. Run `node src/cli.ts integration google connect` to grant the additional `tasks` scope.
2. Configure your presentation, `tasksPolicy` (`--tasks-enabled true --tasks-mode actionable`), and habit modes (`--mode tasks --start-date YYYY-MM-DD`).
3. Run the dry-run migration preview:

   ```sh
   node src/cli.ts --json integration google migrate --preview --from 2026-10-17 --through 2026-10-23
   ```

4. Inspect the summary (`retainedEvents`, `visualUpdates`, `newGoogleTasks`, `habitOccurrencesToCreate`, `eventsProposedForRetirement`, `conflicts`). After approving the preview, run:

   ```sh
   node src/cli.ts --json integration google migrate --from 2026-10-17 --through 2026-10-23 --approve MIGRATION_HASH
   ```

`migrate` preserves all existing Focus session and commitment event IDs (`mappings.json`), updates their titles and custom labels in place, creates and verifies replacement Google Tasks and habit task occurrences first, and retires old recurring Calendar habit series in **Syntrop · Habits** only after replacement habit tasks succeed with zero failures.

## Create or update your Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), reuse your existing personal project or create one. Do not modify or delete unrelated OAuth Web clients.
2. Under **APIs & Services → Library**, ensure both **Google Calendar API** (`calendar-json.googleapis.com`) and **Google Tasks API** (`tasks.googleapis.com`) are **Enabled**.
3. Under **Google Auth platform → Audience**, leave a personal installation in **Testing** and ensure your Google account email is listed under **Test users**.
4. Under **Data Access → Add or remove scopes**, configure:
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/tasks`
   - Optional: `https://www.googleapis.com/auth/calendar.events.freebusy` (only if using `integration google availability`)
5. Reuse your downloaded **Desktop app** client JSON with `setup --client`. Do not enable billing or alter OAuth publishing status for personal testing. External apps in Testing mode normally receive refresh tokens that expire after approximately seven days; rerun `integration google connect` when reconnection is required.

## What appears in Google Calendar vs Google Tasks

| Local record | Destination | Representation & behavior |
| --- | --- | --- |
| Scheduled work session | **Syntrop · Focus** (Calendar) | Timed busy event (`[start, end)`), `Project · Short Title`, custom HEX label (`eventLabelId`) or `colorId` fallback |
| Selected local commitment | **Syntrop · Focus** (Calendar) | Timed busy event |
| Actionable task (`tasksPolicy`) | **Syntrop · Tasks** (Tasks list) | Native completable Google Task (`needsAction` / `completed`), optional `due` date (`YYYY-MM-DD`) |
| Daily / weekly habit (`mode: tasks`) | **Syntrop · Habits** (Tasks list) | One completable Google Task per occurrence across the rolling horizon (default 14 days) |
| Habit (`mode: flexible` / `timed`) | **Syntrop · Habits** (Calendar) | Optional/legacy recurring Calendar reminder series (`RRULE`) |
| Optional task deadline | **Syntrop · Focus** (Calendar) | All-day transparent marker (off by default when native Tasks are active to avoid duplicate clutter) |

### Custom event labels and presentation design

Structured presentation settings (`integration google presentation --file FILE`) allow the agent to define up to 25 custom labels with `#RRGGBB` colors, concise project `shortName` prefixes, and concise task `shortTitle` overrides:

```json
{
  "version": 1,
  "theme": {
    "name": "focused-atelier",
    "style": "minimal",
    "sessionPrefix": "project",
    "labels": {
      "career": { "name": "Career", "color": "#1d4ed8" },
      "oss": { "name": "OSS", "color": "#7c3aed" },
      "editor": { "name": "Editor", "color": "#0f766e" }
    }
  },
  "projects": {
    "prj_example": { "label": "career", "shortName": "Career" }
  },
  "tasks": {
    "tsk_example": { "shortTitle": "Finalize Resume" }
  }
}
```

Syntrop generates deterministic RFC 4122 UUIDs for each custom label (`labelIdentity(workspaceId, key)`), merges them with existing calendar labels via `PATCH /calendars/{focus}` (`labelProperties.eventLabels`), and writes events with `eventLabelVersion=1` and `eventLabelId`. If a provider or frontend does not support custom event labels, Syntrop automatically falls back to the closest standard `colorId` palette entry (`nearestColorId`).

### Google Tasks capability boundaries and completion reconciliation

- **Date-only `due` field**: The public Google Tasks API v1 stores only the date portion (`YYYY-MM-DDT00:00:00.000Z`) and discards time-of-day. Timed work sessions therefore remain Calendar events in **Syntrop · Focus**, while actionable checklists live in **Syntrop · Tasks**.
- **Bounded rolling habit horizon**: Because Google Tasks API v1 does not expose recurrence-rule creation (`RRULE`), Syntrop projects individual dated habit task occurrences (`habit-task:<habitId>:<YYYY-MM-DD>`) across a bounded rolling horizon (default 14 days) and extends the horizon idempotently during future syncs. Run `integration google diagnose` to inspect remaining horizon days.
- **Controlled completion reconciliation (`reconcile`)**:
  - Checking off a task in **Syntrop · Tasks** and running `reconcile` marks the local task `done` (verifying all DAG prerequisites are `done` and the project is `active`), cancels only future scheduled work sessions, and preserves past session history (`session_outcomes` are never fabricated from task checkboxes).
  - Checking off a habit task in **Syntrop · Habits** and running `reconcile` records `habit log` for the mapped local `occurrenceDate` (`YYYY-MM-DD` in the workspace timezone), even if checked off after midnight in UTC.
  - Unchecking a previously completed task/habit in Google or checking off a dependency-blocked task surfaces a `conflict` action requiring explicit user review.
- **Ownership safety under the `tasks` scope**: Although `https://www.googleapis.com/auth/tasks` is broad at the Google OAuth level, Syntrop restricts all writes to the managed task lists registered in `tasklists.json` and verifies `Syntrop workspace:` / `Syntrop source:` ownership lines in task `notes` before updating or deleting any task. Unrelated personal task lists and tasks are never modified or cleared.
- **Standing auto-sync authorization**: Enabling `configure --auto-sync true --auto-reconcile true` permits your active AI agent to run `sync --auto` and `reconcile --auto` during normal operational turns without extra prompts, halting safely if any remote conflict is detected. This is agent-driven during active sessions, not a background daemon.
- **Notion Calendar boundary**: Notion Calendar displays connected Google Calendar events (`Syntrop · Focus`), whereas native Google Tasks (`Syntrop · Tasks` and `Syntrop · Habits`) are designed for Google Calendar web/mobile and Google Tasks apps.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `MISSING_SCOPE` for `tasks` | Run `node src/cli.ts integration google connect` and approve Google Tasks access in the browser consent screen. |
| Tasks API disabled (`403 accessNotConfigured`) | Enable **Google Tasks API** (`tasks.googleapis.com`) in the same Google Cloud project as your Desktop OAuth client. |
| `invalid_grant` / expired refresh token | Rerun `integration google connect`. External Testing-mode refresh tokens can expire after ~7 days. |
| Completed task in Google not reconciled | Run `integration google reconcile --preview` then `--approve HASH` (or `--auto`). Ensure the task was checked off inside the managed `Syntrop · Tasks` or `Syntrop · Habits` list. |
| Blocked task completion conflict | The task has unfinished Syntrop DAG prerequisites (`blockedBy`). Complete prerequisites first or resolve the conflict explicitly in Syntrop. |
| Habit horizon warning (`horizonNeedsExtension`) | Run `integration google preview` and `sync` for the upcoming date range to extend the rolling habit task horizon. |
| Missing managed calendar or task list | Run `integration google diagnose`. Use `recover --focus ID --habits ID --tasks-list ID --habits-list ID` with verified owned IDs. |

## Controlled live evidence — 2026-10-17

- **v0.3.0 Live Calendar Evidence**: Verified Desktop OAuth (`calendar.app.created`), managed Focus calendar creation, private session event creation (`Asia/Jakarta`), repeat no-op sync, session move preserving remote ID, session cancellation (`status: cancelled`), and disposable calendar `DELETE` cleanup.
- **v0.4.0 Live Calendar, Custom Event Labels, Google Tasks & Migration Evidence**:
  - **Incremental OAuth & Diagnostics**: Verified live Desktop OAuth incremental consent granting both `https://www.googleapis.com/auth/calendar.app.created` and `https://www.googleapis.com/auth/tasks` (`tasksConnected: true`, `tasksScopeGranted: true`).
  - **15-Scenario Isolated Synthetic Live Smoke Test (`Asia/Jakarta`)**: Using production `GoogleClient`, `planSync`, `applySync`, `planTasksSync`, `applyTasksSync`, `planReconcile`, and `applyReconcile` in an isolated workspace:
    - Created dedicated disposable Focus calendar and managed task lists; verified custom `#RRGGBB` event labels (`labelProperties.eventLabels` with RFC 4122 UUIDs, `labelCapability: "supported"`, `labelMode: "custom-labels"`) and event read-back with `?eventLabelVersion=1` (`eventLabelId` matched custom label UUID; Google omits legacy `colorId` when a custom `eventLabelId` is active).
    - Verified native Google Tasks creation (`due: "YYYY-MM-DDT00:00:00.000Z"`, `status: "needsAction"`, ownership footer), in-place task title updates preserving remote task IDs, and repeat sync idempotency (`unchanged: 2` Calendar, `unchanged: 7` Tasks, zero duplicates).
    - Verified live completion reconciliation (`integration google reconcile`): completing a ready task in Google Tasks marked the local SQLite task `done`, cancelled only future scheduled work sessions, and preserved past sessions; completing a dependency-blocked task in Google Tasks was safely held as a `conflict: 1` (`inbox` preserved); completing a daily habit task with a post-midnight UTC timestamp (`2026-10-17T18:30:00.000Z`) reconciled to the mapped local `Asia/Jakarta` occurrence date (`2026-10-17`).
    - Verified ownership boundaries (unowned manual tasks and manual calendar events in managed lists/calendars remained untouched during `sync --resolve local`) and deleted all disposable test calendars and task lists (`DELETE`).
  - **Live Personal Workspace Migration (`v0.3.0 -> v0.4.0`)**:
    - Inspected existing v0.3.0 personal calendars (`unchanged: 24, conflict: 0` after handling Google Calendar's built-in `eventLabelId` UUID mirroring on legacy `colorId` events), then executed `integration google migrate` (`2026-10-17..2026-10-23`): updated all 21 Focus events in place (`updated: 21`, preserving every remote event ID with concise `Project · Short Title` summaries and 5 custom HEX labels), created 2 managed Google Task lists (`Syntrop · Tasks` and `Syntrop · Habits`) with 4 actionable tasks and 21 daily habit occurrences (`tasks.created: 25`), and retired 3 legacy recurring Calendar habit series (`cancelled: 3`, `failed: 0`, `conflicted: 0`).
    - Verified post-migration idempotency (`unchanged: 21` Calendar, `unchanged: 25` Tasks) and live 14-day rolling habit horizon extension (`2026-10-17..2026-10-30`: `create: 21` new habit tasks for `2026-10-24..2026-10-30`, `unchanged: 25`, followed by idempotent `unchanged: 46` Tasks and `unchanged: 21` Calendar).

