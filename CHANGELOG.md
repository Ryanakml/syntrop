# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-17

Adaptive Calendar & Google Tasks Integration (Beta).

### Added
- **Native Google Tasks Integration (`Syntrop · Tasks` & `Syntrop · Habits`)**:
  - Actionable Syntrop tasks project into a dedicated managed **Syntrop · Tasks** list with configurable policies (`actionable`, `scheduled`, `selected`, `ready`, `none`) and ownership metadata (`Syntrop workspace:` / `Syntrop source:` / `Syntrop hash:`).
  - Daily and weekly habits (`--mode tasks`) project as individually completable dated Google Tasks in **Syntrop · Habits** over a bounded rolling horizon (default 14 days, max 90 days) without fabricating historical completions for already-logged past days.
  - Paginated task inspection (`showCompleted=true&showHidden=true&showDeleted=true`) and uncertain `POST` creation recovery to prevent duplicate tasks after network timeouts.
- **Controlled Completion Reconciliation (`integration google reconcile`)**:
  - Reconciles verified Google Task completion (`status: 'completed'`) into Syntrop (`task done` semantics: checks DAG prerequisites, active project, optimistic version, cancels only future scheduled work sessions, and preserves past session history without fabricating `session_outcomes`).
  - Reconciles verified habit task completion into `habit_occurrences` (`habit log` semantics) using the mapped local `occurrenceDate` in the workspace IANA timezone rather than raw UTC completion timestamps.
  - Surfaces conflicts when a completed task or habit occurrence is unchecked remotely or when a dependency-blocked task is checked off before its prerequisites.
- **Agent-Designed Calendar Presentation & Custom Event Labels (`integration google presentation`)**:
  - Versioned `presentation` schema supporting user-defined categories and custom `#RRGGBB` HEX labels (`theme.labels`), concise project `shortName` prefixes, concise task `shortTitle` overrides, and habit `shortName` display titles while preserving full local operational records.
  - Native Google Calendar custom event label synchronization (`labelProperties.eventLabels` with deterministic RFC 4122 UUIDs and `eventLabelVersion=1` on event writes), preserving existing calendar labels and automatically falling back to nearest standard `colorId` palette entries if unsupported.
  - New [syntrop-calendar-presentation](skills/syntrop-calendar-presentation/SKILL.md) skill and updated cognitive routing contract in [AGENTS.md](AGENTS.md).
- **Safe v0.3.0 Migration & Diagnostics (`integration google migrate` & `diagnose`)**:
  - Preserves existing v0.3.0 Focus calendar session and commitment event IDs (`mappings.json`) without false drift conflicts from Google's built-in `eventLabelId` UUID mirroring on `colorId` events.
  - Creates and verifies replacement Google Tasks and habit task occurrences before retiring redundant Calendar habit series (`skipHabitRetire` guard).
  - Opt-in per-workspace standing authorization (`--auto-sync`, `--auto-reconcile`, `--auto`) for agent-driven synchronization and reconciliation during active sessions.

### Changed
- `integration google connect` now requests both `calendar.app.created` and `tasks` by default using incremental authorization (`include_granted_scopes=true`) while preserving existing refresh tokens (`--calendar-only` remains available).
- `integration google preview`, `sync`, and `recover` coordinate both managed calendars and managed Google Tasks lists when Tasks projection is active.
- Live verification completed on 2026-10-17 against Google Calendar API v3 and Google Tasks API v1: 15-scenario isolated synthetic smoke test (custom `#RRGGBB` event labels, task/habit projection, completion reconciliation with DAG prerequisite enforcement and local timezone habit date mapping, ownership boundaries, and cleanup) plus live v0.3.0-to-v0.4.0 personal workspace migration (21 Focus events upgraded in place, 2 managed task lists created, 4 actionable tasks + 42 rolling 14-day habit tasks projected with verified idempotency).

### Limitations
- Public Google Tasks API v1 stores date-only `due` fields (discarding time-of-day), does not expose recurring-rule creation (`RRULE`), and does not support custom per-task HEX colors. Timed execution blocks remain Calendar events in `Syntrop · Focus`.
- Synchronization and completion reconciliation remain explicit or agent-driven during active sessions; no background daemon or unrestricted bidirectional editing is introduced.
- Notion Calendar displays connected Google Calendar events (`Syntrop · Focus`), whereas native Google Tasks (`Syntrop · Tasks` and `Syntrop · Habits`) are targeted at Google Calendar web/mobile and Google Tasks interfaces.

## [0.3.0] - 2026-10-17

Calendar Integration beta. Google OAuth consent, live API smoke, and human-visible calendar QA are **not completed**: no account-owner Desktop OAuth client is available. This is not a production-readiness claim.

### Added
- Optional `integration google` CLI boundary: Desktop OAuth setup/connect/status/disconnect, configuration, habit selection, online/offline preview, approval-hash sync, managed calendar recovery, colors, and optional external free/busy.
- Least-privilege `calendar.app.created` authorization with PKCE S256, random loopback redirect, state/Host/origin validation, refresh/reconnect handling, and fixed Google endpoints.
- Credentials and projection state in a separate private directory outside operational workspace backups/exports; restrictive file permissions and sanitized errors.
- Dedicated Focus/Habits calendars, redacted-by-default titles, disabled default reminders, explicit project palette mapping, optional all-day deadlines, opted-in flexible/timed native habit recurrence.
- Stable Google-valid IDs, private ownership metadata, paginated reconciliation, drift/deletion conflicts, ETag conditional updates, verified writes, partial-progress checkpoints, and safe interrupted calendar creation recovery.
- Pure mapping, mocked HTTP/OAuth callback, fake-provider synchronization, and complete mocked CLI workflow regression coverage; live verification remains separately blocked.

### Changed
- Existing CLI core operations remain offline; explicitly invoked Google integration commands can use the network. Local `calendar` commands retain their original semantics.
- Scheduling/habit instructions compose with opt-in preview, external availability, privacy and publishing boundaries.
- Calendar design, beginner Google Cloud onboarding, recovery, Notion/mobile viewing, compatibility and validation documentation added.

### Limitations
- Manual one-way projection only; no continuous daemon or unrestricted bidirectional sync.
- Recurring instance exceptions require manual resolution in Google. Whole-series changes use provider series semantics and can affect prior displayed occurrences; habit occurrence logs remain local and unchanged.
- Original downloaded Desktop client files must be stored outside source/workspace; no bundled client, credentials, mandatory hosted backend, or npm publication.
- No core schema/migration changes. Optional ICS snapshot export deferred to prioritize the authenticated path.

## [0.2.0] - 2026-10-16

Beta release; published with GitHub prerelease metadata. No npm publication.

### Added
- Per-intent epistemic readiness gate in the canonical agent contract, with direct-action fast paths and explicit evidence, decision, authorization, and blocked branches.
- Artifact reconnaissance and planning smell tests, including legitimate research tasks and provisional-plan exceptions.
- Reproducible synthetic behavioral scenarios, static contract checks, and trace-based evaluation procedure separating instruction integrity from observed LLM behavior.
- Gemini CLI discovery adapter and evidence-backed cognitive architecture design.
- Trace-backed evaluation report: 15 distinct scenarios exercised, one initial scope failure corrected and rerun; external-tool restriction scenario explicitly untested.

### Changed
- Six specialist skills compose around research/reasoning prerequisites, scoped permission, realistic scheduling, and recorded-outcome reflection.
- Claude, Cursor, and Copilot adapters defer to one canonical protocol.
- Documentation separates engine guarantees from prompt-guided behavior and runtime-specific discovery capabilities.
- Package metadata includes cognitive protocol documentation and evaluation resources.

### Compatibility
- No database schema, migration, CLI command, or operational invariant changes.
- Local-first storage, zero runtime dependencies, Node 24 requirement, and legacy `life` binary alias preserved.
- Cognitive routing and authorization remain agent-guided; static/CLI checks do not establish universal model or runtime reliability.

## [0.1.0] - 2026-10-15

### Added
- **Core Operations Engine (Syntrop)**:
  - Deterministic SQLite storage powered by native Node.js 24 `node:sqlite` (`DatabaseSync` & `backup`).
  - Strict ACID transaction guarantees with `BEGIN IMMEDIATE` and automated rollback on failure.
  - Zero external runtime npm dependencies.
  - Default private workspace at `~/.syntrop` (overridable via `SYNTROP_WORKSPACE` or `--workspace`).
- **Task & Goal DAG Management**:
  - Topological Directed Acyclic Graph (DAG) task dependencies (`--depends-on`).
  - Pre-commit cycle detection and dependency graph validation.
  - Computed task readiness (`status in (inbox, todo, in_progress)` + all prerequisites `done` + project active).
  - Explicit override tracking (`--allow-blocked --reason` and `--allow-open-tasks --reason`).
- **Calendar & Session Scheduling**:
  - Half-open interval conflict detection `[start, end)` rejecting overlapping active sessions and events.
  - Separation of task deadlines from allocated execution sessions.
  - Session outcome recording (`completed`, `skipped`, `actual-minutes`, `note`) with versioned audit trails.
- **Habit Tracking**:
  - Habit definitions with daily/weekly frequency targets.
  - Logical date-keyed occurrence logs with versioned correction capabilities (`--correct`).
- **Transactional Decisions**:
  - Immutable decision logging (`decision add`) transactionally bound to projects and source citations.
- **Resilience & Machine Interface**:
  - Optimistic concurrency control via `--expected-version`.
  - Idempotent request replay via `--idempotency-key`.
  - Machine-readable `--json` output across all commands with structured exit codes (`2` = validation, `3` = conflict, `4` = workspace).
  - Versioned migration backups using SQLite `VACUUM INTO`.
  - Non-destructive view generation in `views/generated/` escaping untrusted text.
  - Source checkout path guards (`assertOutsideSource`) preventing accidental private data check-in.
  - Workspace health check via `syntrop doctor`.
  - Automated system timezone detection on `syntrop init`.
  - Binary mappings for `syntrop`, `syn`, and backward-compatible `life`.
- **Multi-Agent Ecosystem Support**:
  - Canonical agent operating contract in `AGENTS.md`.
  - Six specialized workflow skills in `skills/` (planning, scheduling, habits, reflection, research, reasoning).
  - Cross-agent hub-and-spoke integration configs (`CLAUDE.md`, `.cursor/rules/syntrop.mdc`, `.github/copilot-instructions.md`).
- **Developer & Release Infrastructure**:
  - GitHub Actions CI workflow supporting Node 24 on Ubuntu and macOS.
  - Comprehensive documentation suite (`getting-started.md`, `cli-reference.md`, `architecture.md`, `agent-integration.md`).
  - Interactive demonstration tour (`examples/tour.sh`) and programmatic verification (`examples/demo.mjs`).
  - Community contribution guides (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates).
