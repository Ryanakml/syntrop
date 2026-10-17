<div align="center">
  <img src="assets/syntrop-icon.svg" width="132" height="132" alt="Syntrop - The Deterministic Operations Kernel for AI Coding Agents" />
  <h1>SYNTROP</h1>
  <p><strong>The Deterministic Operations Kernel for AI Coding Agents</strong></p>
  <p><em>A local-first SQLite operations engine with evidence-aware agent workflows, task dependencies, and conflict-checked schedules.</em></p>

  <p>
    <a href="https://github.com/ryanakml/syntrop/actions"><img src="https://github.com/ryanakml/syntrop/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D24.15-brightgreen.svg?style=flat-square" alt="Node Version" /></a>
    <a href="package.json"><img src="https://img.shields.io/badge/runtime%20deps-0-blue.svg?style=flat-square" alt="0 Runtime Dependencies" /></a>
    <a href="docs/architecture.md"><img src="https://img.shields.io/badge/storage-SQLite%203%20ACID-orange.svg?style=flat-square" alt="Storage Engine" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
    <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/release-v0.4.0-yellow.svg?style=flat-square" alt="Release" /></a>
  </p>

  <p>
    <a href="#the-problem-agent-amnesia--plan-rot"><b>The Problem</b></a> &nbsp;•&nbsp;
    <a href="#dual-layer-architecture"><b>Architecture</b></a> &nbsp;•&nbsp;
    <a href="#30-second-quick-start"><b>Quick Start</b></a> &nbsp;•&nbsp;
    <a href="#ai-agent-integration"><b>Agent Integration</b></a> &nbsp;•&nbsp;
    <a href="docs/cli-reference.md"><b>CLI Manual</b></a>
  </p>
</div>

---


## The Problem: Agent Amnesia & Plan Rot

AI coding agents can generate hundreds of lines of code in seconds, but they suffer from **context window amnesia**. 

When an agent context resets or compacts:
- It forgets prior execution history.
- It hallucinates uncompleted tasks as done.
- When tracked in flat `TODO.md` files, concurrent agents corrupt syntax, create circular dependencies, and clobber notes.
- Remote tools add network and account dependencies; some users prefer to keep operational records on local disk.

**Syntrop** (derived from *syntropy* — the creation of order out of chaos) provides a durable operational foundation for this workflow. It is a zero-dependency, local-first personal operations engine that equips AI coding agents and human builders with **deterministic operational state**: topological DAG task graphs, conflict-checked calendar intervals, optimistic concurrency locking, and immutable decision logs.

---

## Dual-Layer Architecture

Syntrop separates **cognitive reasoning** from **deterministic state mutations**:

```mermaid
flowchart TD
    subgraph Human["Human & Narrative Context"]
        U["User (Conversational Intent)"]
        Notes["Markdown Notes (knowledge/, journal/)"]
    end

    subgraph Agent["AI Coding Agent (Reasoning Layer)"]
        Prompt["AGENTS.md & Skills"]
        LLM["AI Agent (Antigravity / Claude Code / Cursor / Codex)"]
    end

    subgraph Core["Syntrop Core Engine (Deterministic Layer)"]
        CLI["CLI Engine (src/cli.ts)"]
        Rules{"Invariants Engine\n(DAG Cycles, Schedule Conflicts, Versions)"}
        DB[("SQLite Database\n(~/.syntrop/data/life.db)")]
        Generated["Compiled Views\n(views/generated/)"]
    end

    U <--> LLM
    Notes <--> LLM
    Prompt --> LLM
    LLM -->|"Deterministic RPC (syntrop --json)"| CLI
    CLI --> Rules
    Rules -->|"ACID Commit (BEGIN IMMEDIATE)"| DB
    Rules -->|"Conflict Rejection (Exit 2/3)"| CLI
    CLI -->|"Safe Markdown Generation"| Generated
    CLI -->|"Structured JSON Feedback"| LLM
```

---

## Architectural Invariants

* 🛡️ **Zero Runtime Dependencies**: Built exclusively on native Node.js 24 core modules (`node:sqlite`, `node:crypto`, `node:fs`, `node:path`). No runtime npm installation, `node-gyp`, or Python toolchain is needed.
* 🔒 **Local CLI Boundary**: Core commands work offline and never invoke LLMs. Explicit `integration google` network operations are optional and require separate consent. The active agent may also use external tools according to its runtime settings.
* 🕸️ **Topological DAG Dependencies**: Tasks form a Directed Acyclic Graph. Cycles are rejected at commit time. `syntrop task next` returns one ready action whose prerequisites are finished.
* ⏱️ **Conflict-Checked Half-Open Schedules**: Active work sessions and calendar events enforce half-open intervals `[start, end)`. Overlaps are rejected inside the transaction.
* 🔄 **Optimistic Locking & Idempotency**: Guard concurrent agent updates with `--expected-version N` and retry safely using `--idempotency-key KEY`.
* 🛡️ **Physical Workspace Sovereignty**: Code resides in the public repository; private data lives in `~/.syntrop`. The engine refuses workspace initialization inside the source checkout.
* 📄 **Non-Destructive View Generation**: Daily/weekly agendas compile strictly to `views/generated/`. Human narrative Markdown in `knowledge/` and `journal/` is never overwritten.

---

## 30-Second Quick Start

### 1. Prerequisites
Syntrop requires **Node.js >= 24.15.0 < 25** (Node 24 LTS):
```sh
node -v   # Must be >= 24.15.0
```

### 2. Setup
```sh
git clone https://github.com/ryanakml/syntrop.git
cd syntrop
chmod +x src/cli.ts
npm link   # Exposes `syntrop` (and alias `syn`) globally
```

### 3. Initialize Workspace
```sh
# Auto-detects your local system timezone and creates ~/.syntrop
syntrop init

# Verify workspace health
syntrop doctor
```

### 4. Core Workflow in 4 Commands
```sh
# Add a project and dependent tasks
syntrop project add --title "Launch Open-Source Project"
syntrop task add --title "Audit security and licensing" --status todo
# Output prints Task 1 ID (e.g. tsk_1234...). Use it as a prerequisite for Task 2:
syntrop task add --title "Publish release candidate" --status todo --depends-on <TASK_1_ID>

# Query only actionable, unblocked tasks (Task 2 is blocked, so only Task 1 appears!)
syntrop task next

# Mark task 1 completed (Task 2 will now automatically unblock and appear in `task next`!)
syntrop task done <TASK_1_ID>
```

*(Note: `syn` and `life` are also provided as CLI aliases for `syntrop`!)*

---

## Optional Google Calendar & Tasks Integration

Syntrop remains the operational source of truth while projecting each concept into its native Google Workspace representation:
- **Google Calendar Events (`Syntrop · Focus`)**: Reserved time blocks for scheduled work sessions (`[start, end)`) and commitments, styled with agent-designed concise display titles (`Project · Short Title`) and custom HEX event labels (`labelProperties.eventLabels` + `eventLabelId`, with automatic fallback to standard `colorId` palette entries).
- **Native Google Tasks (`Syntrop · Tasks` & `Syntrop · Habits`)**: Actionable Syntrop tasks and individually completable daily/weekly habit occurrences projected over a bounded rolling horizon (default 14 days).
- **Controlled Completion Reconciliation (`Google Tasks -> Syntrop`)**: Checking off a managed Google Task or habit occurrence can be reconciled back into Syntrop via `integration google reconcile`, enforcing DAG prerequisites, active project guards, version checks, and local-timezone occurrence dates without fabricating work-session outcomes.

```sh
syntrop integration google setup --client /absolute/path/desktop-client.json
syntrop integration google connect
syntrop integration google configure --title-mode titles --tasks-enabled true --tasks-mode actionable
syntrop integration google habit --id HABIT_ID --mode tasks --start-date 2026-10-17 --horizon-days 14
syntrop --json integration google preview --from 2026-10-17 --through 2026-10-23
syntrop --json integration google sync --from 2026-10-17 --through 2026-10-23 --approve PLAN_HASH
# Reconcile tasks and habits completed in Google Calendar / Google Tasks:
syntrop --json integration google reconcile --preview
syntrop --json integration google reconcile --approve RECONCILE_HASH
```

Upgrading from v0.3.0 preserves existing Focus calendar event IDs, creates replacement Google Tasks and habit task occurrences first, and retires redundant Calendar habit series only after replacement tasks are verified (`syntrop integration google migrate --preview`). Optional per-workspace standing authorization (`--auto-sync true --auto-reconcile true`) lets your active AI agent synchronize and reconcile within normal operational turns without a background daemon. See the [Google Calendar & Tasks guide](docs/integrations/google-calendar.md) and [architecture design](docs/calendar-design.md).

---

## Interactive Demonstrations

Experience DAG task resolution, schedule conflict rejection, and decision recording in an isolated sandbox:

```sh
# Run the interactive automated walkthrough (creates and cleans up a temporary sandbox)
./examples/tour.sh

# Or run the programmatic JavaScript verification demo
node examples/demo.mjs
```

---

## AI Agent Integration

[AGENTS.md](AGENTS.md) is the canonical cognitive protocol. Each independent intent takes the minimum sufficient path: a clear authorized action proceeds directly; a consequential plan waits for decision-changing evidence and unresolved choices. Research and reasoning feed planning only when needed. Readiness labels (`READY`, `NEEDS_EVIDENCE`, `NEEDS_DECISION`, `NEEDS_AUTHORIZATION`, `BLOCKED`) guide the agent; they are not new database statuses.

Thin adapters point each runtime to that protocol:

* **Claude Code**: [CLAUDE.md](CLAUDE.md).
* **Cursor**: [.cursor/rules/syntrop.mdc](.cursor/rules/syntrop.mdc).
* **GitHub Copilot**: [.github/copilot-instructions.md](.github/copilot-instructions.md).
* **Gemini CLI**: [GEMINI.md](GEMINI.md), its default context filename.
* **Codex**: [AGENTS.md](AGENTS.md).
* **Other runtimes, including Antigravity**: explicitly ask the agent to read `AGENTS.md`; automatic discovery is unverified.

The seven [skills](skills/) provide focused workflows—including [calendar presentation design](skills/syntrop-calendar-presentation/SKILL.md)—and are read as needed through `AGENTS.md`. They do not install themselves or create subagents. See the [integration guide](docs/agent-integration.md) for documented discovery mechanisms and runtime verification limits.

### Prompt Your Agent
Open your agent inside this repository and paste:
> *"You are my operations partner using Syntrop. Read `AGENTS.md` and run `syntrop doctor --json` to inspect our workspace. Inspect relevant goals, projects, tasks, and calendar commitments before recommending today's focus. Do not commit database mutations until authorized."*

For detailed setup, see the [Agent Integration Guide](docs/agent-integration.md).

---

## CLI Overview

| Category | Commands |
| :--- | :--- |
| **Workspace** | `syntrop init`, `syntrop doctor`, `syntrop validate`, `syntrop backup`, `syntrop restore`, `syntrop export` |
| **Goals & Projects** | `syntrop goal add\|list\|show\|update`, `syntrop project add\|list\|show\|update` |
| **Tasks & DAGs** | `syntrop task add\|list\|next\|show\|update\|done\|cancel`, `syntrop task depends add\|remove` |
| **Sessions & Calendar** | `syntrop schedule add\|list\|move\|cancel\|record`, `syntrop calendar add\|list\|move\|cancel` |
| **Habits** | `syntrop habit add\|list\|show\|update\|log\|history` |
| **Decisions** | `syntrop decision add\|list\|show` |
| **Optional Google Integration** | `syntrop integration google setup\|connect\|status\|configure\|presentation\|habit\|tasks\|preview\|sync\|reconcile\|migrate\|diagnose\|calendars\|colors\|availability\|recover\|disconnect` |
| **Views & Reviews** | `syntrop today`, `syntrop tomorrow`, `syntrop week`, `syntrop review week` |

*All commands support `--json` for structured output and exit codes `0` (ok), `2` (validation), `3` (conflict), and `4` (workspace).*  
For full syntax, see the [CLI Reference](docs/cli-reference.md).

---

## Documentation

- [Getting Started Guide](docs/getting-started.md) — Comprehensive first-run onboarding walkthrough.
- [CLI Reference](docs/cli-reference.md) — Complete command flags, options, exit codes, and JSON schemas.
- [Architecture & Invariants](docs/architecture.md) — Invariant specifications, migrations, and concurrency model.
- [Agent Integration Guide](docs/agent-integration.md) — Multi-agent setup, prompt patterns, and skills catalog.
- [Google Calendar & Tasks Setup](docs/integrations/google-calendar.md) — Desktop OAuth, Tasks projection, completion reconciliation, presentation themes, and v0.3.0 migration.
- [Calendar & Tasks Architecture](docs/calendar-design.md) — Scope decisions, ownership, custom event labels, reconciliation, and API capability boundaries.
- [Behavior Evaluation Guide](evals/README.md) — Scenario fixtures, scoring, and limits of behavioral evidence.
- [Contributing Guidelines](CONTRIBUTING.md) — Development environment, testing, and pull request process.
- [Security Policy](SECURITY.md) — Responsible disclosure and threat model.

---

## Current Status & Limitations

Syntrop is currently in **Beta (v0.4.0)**.
- **Local-First & Single-User**: Designed for single-user local disk operations. Multi-device sync is handled via external backup or personal git repositories.
- **Node 24 Requirement**: Leverages `node:sqlite` and native TypeScript type stripping; requires Node.js >= 24.15.0 < 25.
- **Controlled Google Synchronization**: Calendar and Tasks projection is opt-in and agent- or user-driven; there is no background daemon or unrestricted bidirectional editing. Only verified completion signals on workspace-owned Google Tasks and habit occurrences are reconciled into Syntrop.
- **Google Tasks API Boundaries**: The public Google Tasks API v1 stores date-only `due` fields (discarding time-of-day), does not expose recurring-rule creation via the REST API, and does not support custom per-task HEX colors. Syntrop projects bounded dated habit occurrences and uses Calendar events for timed blocks.
- **No Autonomous Daemon**: Syntrop does not run background services or send push notifications. Review, synchronization, and reconciliation occur when initiated by the user or active agent.
- **Agent-Guided Judgment**: Evidence checks, presentation design, and planning readiness are instructions for the active agent, not engine guarantees. The CLI can reserve future sessions for dependency-blocked tasks; the agent must check readiness and prerequisite timing before proposing a session.
- **Evaluation Boundaries**: Engine tests verify deterministic behavior. Scenario fixtures and instruction checks do not prove reliable behavior across models or runtimes; see [evals](evals/README.md).
- **Zero Built-in LLM Dependencies**: Syntrop does not bundle proprietary LLM tokens or API keys. Reasoning is driven by the user's active AI agent runtime.

---

## License

This project is licensed under the [MIT License](LICENSE).  
Copyright (c) 2026 Syntrop contributors.
