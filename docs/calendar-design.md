# Calendar & Tasks projection architecture decision

Status: optional Google Calendar & Tasks integration, beta (v0.4.0). Research and live API verification checked **2026-10-17**. Implementation tests, live Google API smoke tests, and frontend UI rendering are tracked as distinct evidence levels.

## Decision and boundary

Keep SQLite and the existing core schema canonical. Isolate Google operations in `src/google-*.ts` and `integration google` commands. Local `calendar` commands retain their commitment semantics. The CLI needs no built-in LLM or hosted backend; core commands remain offline. Only explicitly invoked Google operations use the network. The active AI agent designs presentation (`shortName`, `shortTitle`, custom HEX labels, and Task vs Event assignment), while the deterministic engine validates configuration, enforces ownership, and applies projections.

```text
User ↔ AI Agent (Understand / Plan / Design Presentation)
         ↓ structured presentation & operational CLI
     Syntrop SQLite (Authoritative Operational State)
         ↓ explicit or standing-authorized sync
     Deterministic Projection & Capability Checks
       ├─→ Google Calendar API v3 (Timed Sessions, Commitments, Custom Labels)
       └─→ Google Tasks API v1 (Actionable Tasks & Dated Habit Occurrences)
         ↓ controlled completion reconciliation (reconcile)
     Syntrop SQLite (DAG-checked task done & timezone-safe habit log)
```

Syntrop separates scheduled time from completable work:
- **Scheduled time (`Syntrop · Focus` & `Syntrop · Habits` calendars)**: Reserved intervals `[start, end)` belong on Google Calendar where busy/free blocks and custom event colors/labels exist.
- **Completable work (`Syntrop · Tasks` & `Syntrop · Habits` task lists)**: Actionable tasks and daily/weekly habit checkboxes belong in native Google Tasks so users can check them off directly in Google Calendar web/mobile or Google Tasks.
- **Controlled completion reconciliation**: Rather than unrestricted bidirectional editing (which would create competing DAG/scheduling authority), only verified completion signals on workspace-owned Google Tasks and habit occurrences are reconciled into Syntrop via `integration google reconcile`. No background daemon or webhook server is required. Notion Calendar supports connected Google Calendar events; however, Notion Calendar does not natively render Google Tasks lists in the same way as Google Calendar, so Google Calendar is the primary target for native Tasks checkboxes.

## Authorization and secrets

Use a user-owned Desktop OAuth client, system browser, PKCE S256, random state with callback validation, and a temporary IPv4 loopback listener. Do not implement deprecated out-of-band token paste. Google documents Desktop clients as public clients; the downloaded client secret is not a security boundary. Tokens are never printed. See [Desktop flow](https://developers.google.com/identity/protocols/oauth2/native-app).

The default v0.4.0 scopes are:
- `https://www.googleapis.com/auth/calendar.app.created`: Secondary calendars created by the app and their events ([Calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert) and [Events](https://developers.google.com/workspace/calendar/api/v3/reference/events)).
- `https://www.googleapis.com/auth/tasks`: Google Tasks lists and tasks ([Tasks auth](https://developers.google.com/workspace/tasks/auth)). Because Google offers no single-list narrow OAuth scope for Tasks, Syntrop enforces strict software-level ownership guards: it creates/mutates only task lists registered in `tasklists.json` (`Syntrop · Tasks` and `Syntrop · Habits`), requires `Syntrop workspace: <id>` and `Syntrop source: <key>` metadata in task `notes` before updating or deleting any task, and never calls `tasks.clear` or touches unrelated personal tasks.
- Optional `https://www.googleapis.com/auth/calendar.events.freebusy`: Selected external busy intervals without exposing event titles ([Freebusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)).

Upgrading from v0.3.0 uses incremental authorization (`include_granted_scopes: 'true'`) and preserves the existing refresh token and Calendar registry when reconnecting for Tasks access (`connect --calendar-only` remains available for Calendar-only operation).

Keep client config, tokens, projection preferences, presentation config, mappings, and calendar/task-list IDs in `~/.syntrop-google/<absolute-workspace-path-hash>/`, separate from workspace data (`0700` directories, `0600` files). Existing workspace backups intentionally omit this directory so secrets never leak into backups or exports.

## Projection and presentation contract

| Source | Destination / representation | Rule |
| --- | --- | --- |
| Work session | `Syntrop · Focus` calendar / timed event | One stable ID per session, busy, workspace timezone, `Project · Short Title` |
| Local commitment | `Syntrop · Focus` calendar / timed event | Optional projection; explicitly exclude external duplicates |
| Actionable task (`tasksPolicy`) | `Syntrop · Tasks` task list / native Google Task | Modes: `actionable` (default), `scheduled`, `selected`, `ready`, `none` |
| Habit mode `tasks` | `Syntrop · Habits` task list / dated Google Task per occurrence | Rolling horizon (default 14 days, max 90); local date in workspace timezone |
| Habit mode `flexible` / `timed` | `Syntrop · Habits` calendar / native RRULE series | Legacy/optional Calendar reminder modes preserved for compatibility |
| Optional task deadline | `Syntrop · Focus` calendar / all-day transparent marker | Off by default when native Tasks are active to prevent duplicate clutter |

### Custom event labels and color fallback

Agent-designed presentation configurations (`presentation` v1) define arbitrary user categories (`labels.<key>.name` up to 16 chars, `color` as `#RRGGBB`, max 25 custom labels) alongside per-project `shortName` and per-task `shortTitle` overrides. Full task descriptions and Markdown notes remain local.

On `Syntrop · Focus`, Syntrop generates deterministic RFC 4122 UUIDs (`labelIdentity(workspaceId, key)`) and merges them with Google Calendar's existing `labelProperties.eventLabels` via `PATCH /calendars/{focus}`, preserving any pre-populated or unrelated labels. Events reference `eventLabelId` with query parameter `eventLabelVersion=1`, and record `syntrop_label` in `extendedProperties.private` so Syntrop-managed custom labels are cleanly distinguished from Google Calendar's automatic UUID mirroring on legacy `colorId` events. If a provider/account rejects `labelProperties` or `eventLabelVersion=1`, Syntrop automatically falls back to the nearest supported standard `colorId` palette entry (`nearestColorId`) and records `labelCapability: 'unsupported'`.

### Google Tasks API v1 capability boundaries

- **Date-only `due` field**: Google Tasks REST API v1 stores `due` as an RFC 3339 date (`YYYY-MM-DDT00:00:00.000Z`) and discards time-of-day. Timed execution blocks therefore remain Calendar events in `Syntrop · Focus`.
- **No REST recurrence rule creation**: Repeating tasks cannot be created as an RRULE series via the public Tasks API. Syntrop generates individual dated habit task occurrences (`habit-task:<habitId>:<YYYY-MM-DD>`) across a configurable rolling horizon (`habitHorizonDays`, default 14 days) and extends the horizon idempotently on subsequent syncs.
- **Server-assigned task IDs**: Unlike Calendar events, `tasks.insert` (`POST`) assigns task `id` server-side. `POST /tasks/v1/...` is therefore never blindly retried on network timeouts; `applyTasksSync` inspects existing list items by `Syntrop source:` ownership metadata before inserting.
- **Hidden completed tasks**: `tasks.list` must pass `showCompleted=true&showHidden=true&showDeleted=true` (`maxResults=100`) so tasks checked off in Google Calendar web/mobile UI remain visible for reconciliation.

## Reconciliation, migration, and concurrency

`integration google reconcile` inspects managed task lists and compares owned Google Tasks against local SQLite state and `task-mappings.json`:
- **Task completion (`complete-task`)**: When a managed task transitions to `status === 'completed'`, Syntrop verifies the task exists, is not cancelled, belongs to an active project, has no unfinished DAG prerequisites (`blockedBy`), and matches `expectedVersion`. Applying reconciliation marks the task `done`, cancels only future scheduled work sessions (`start_at > now`), and preserves past work sessions and `session_outcomes` untouched.
- **Habit completion (`complete-habit`)**: When a managed habit occurrence (`habit-task:<habitId>:<YYYY-MM-DD>`) is completed in Google Tasks, Syntrop logs the habit occurrence for its mapped local `occurrenceDate` (`YYYY-MM-DD` in workspace timezone), never the raw UTC `completed` timestamp (preventing post-midnight timezone drift).
- **Conflicts**: Unchecking a previously completed task or habit occurrence in Google, or checking off a task whose Syntrop DAG prerequisites are unfinished, produces an explicit `conflict` action rather than silently mutating local history.

### Safe v0.3.0 -> v0.4.0 migration

`integration google migrate` upgrades existing v0.3.0 workspaces without deleting managed calendars or resetting `mappings.json`. Existing Focus session and commitment event IDs (`s<sha256>`) are preserved and updated in place (`PUT` with `If-Match`) with shortened titles and custom labels. When habits move from Calendar `timed`/`flexible` mode to `tasks`, migration executes in strict order:
1. Sync Focus calendar updates while holding `skipHabitRetire: true` so existing Calendar habit reminders are not removed prematurely.
2. Create and verify replacement native Google Tasks and habit task occurrences in `Syntrop · Tasks` and `Syntrop · Habits`.
3. Retire old recurring Calendar habit series in `Syntrop · Habits` only after replacement habit tasks succeed with zero failures.

## Verification evidence (2026-10-17)

- **UNIT & INTEGRATION TESTED**: 79 automated tests across `tests/*.test.mjs` covering pure projection, custom label UUID generation, fallback to `colorId`, Google Tasks CRUD, hidden completed task pagination, uncertain POST recovery, DAG-checked task completion reconciliation, post-midnight timezone habit reconciliation, v0.3.0 migration preservation, and standing authorization.
- **LIVE API VERIFIED (Google Calendar v3)**: Verified against live Google Calendar API using the production `GoogleClient`, `planSync`, and `applySync`:
  - Existing v0.3.0 `Syntrop · Focus` and `Syntrop · Habits` calendars (24 mapped events) inspected live with zero false-positive drift conflicts after accounting for Google's built-in `eventLabelId` UUID mirroring on `colorId` events.
  - Live disposable calendar creation, custom `labelProperties.eventLabels` `PATCH` with deterministic RFC 4122 UUIDs and custom HEX colors (`#1d4ed8`), event creation with `?eventLabelVersion=1` and `eventLabelId`, read-back verification (`Career · Finalize Resume`, `Asia/Jakarta`), repeat no-op sync idempotency (`unchanged: 1`), and disposable calendar `DELETE` cleanup all succeeded against the live Google Calendar API.
