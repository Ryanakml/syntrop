# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
