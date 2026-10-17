# Getting Started with Syntrop

Welcome to Syntrop. This guide walks you through setting up Syntrop from scratch, initializing your private workspace, and connecting your first AI coding agent.

---

## 1. Prerequisites

Syntrop requires **Node.js 24.15.0 to 24.x** (Node 24 LTS recommended, `engines: >=24.15 <25`) because it uses Node's native SQLite module (`node:sqlite`) and built-in TypeScript type stripping.

Check your current Node version:
```sh
node -v
```

If you need to install or update Node 24:
- **Using nvm**:
  ```sh
  nvm install 24 && nvm use 24
  ```
- **Using Homebrew (macOS)**:
  ```sh
  brew install node@24 && brew link node@24
  ```
- **Using mise**:
  ```sh
  mise use node@24
  ```

---

## 2. Installation & Quick Setup

Syntrop is distributed as a zero-dependency local engine.

```sh
# 1. Clone the repository
git clone https://github.com/ryanakml/syntrop.git
cd syntrop

# 2. Make the CLI executable
chmod +x src/cli.ts

# 3. Optional: Link the binary globally so you can use `syntrop` (or `syn`) everywhere
npm link

# 4. Verify the CLI works
syntrop --help
# (Or using short alias: syn --help, or without linking: ./src/cli.ts --help)
```

> [!NOTE]
> Syntrop has **zero runtime npm dependencies**. Running `npm ci` is strictly optional and only needed if you plan to run automated tests (`npm test`) or compile typechecks (`npm run typecheck`).

---

## 3. Initializing Your Private Workspace

Syntrop maintains a strict separation:
- **Public Engine**: The cloned repository containing the CLI, documentation, and agent skills.
- **Private Workspace**: Your personal database, journals, and goals. By default, this lives at `~/.syntrop` (overridable via `SYNTROP_WORKSPACE` or `--workspace`).

Initialize your workspace:
```sh
syntrop init
```
*Note: Syntrop automatically detects your local system timezone (e.g. `America/New_York`, `Asia/Jakarta`, `Europe/London`). If you want to specify a different timezone, use `syntrop init --timezone <IANA_NAME>`.*

Verify workspace health with `syntrop doctor`:
```sh
syntrop doctor --json
```
Example output (paths, Node version, timezone, and counts vary):
```json
{
  "node": "v24.21.0",
  "workspace": "/Users/<your-username>/.syntrop",
  "timezone": "America/New_York",
  "ok": true,
  "issues": [],
  "counts": {
    "goals": 0,
    "projects": 0,
    "tasks": 0,
    "work_sessions": 0,
    "session_outcomes": 0,
    "calendar_events": 0,
    "habits": 0,
    "habit_occurrences": 0,
    "decisions": 0
  }
}
```

---

## 4. Your First Manual Operations

Try these commands to see how Syntrop manages your operational graph:

```sh
# 1. Create a goal and a project
syntrop goal add --title "Master Local-First AI Tooling"
syntrop project add --title "Syntrop Onboarding & Setup"

# 2. Add tasks with dependency constraints
# (Task B cannot be completed until Task A is done!)
syntrop task add --title "Review AGENTS.md and skills" --status todo
# Output prints Task 1 ID. Use it as prerequisite:
syntrop task add --title "Connect AI coding agent" --status todo --depends-on <TASK_1_ID>

# 3. Query the next ready action (Task 2 is blocked, so Task 1 appears!)
syntrop task next

# 4. After checking prerequisites and existing commitments, reserve a future work session
syntrop schedule add --task <TASK_1_ID> --start <START_ISO_WITH_OFFSET> --end <END_ISO_WITH_OFFSET>

# 5. Inspect today's operational agenda
syntrop today
```

Replace angle-bracket placeholders before running the commands. For example, use an available future interval such as `2026-10-19T09:00+07:00` to `2026-10-19T10:00+07:00`. Inspect `syntrop calendar list --json` and `syntrop schedule list --json` first. The CLI permits sessions for dependency-blocked future tasks, so readiness and prerequisite timing require your or your agent's judgment.

After changes, run `syntrop validate --json` and read back the affected records, for example `syntrop task show <TASK_1_ID> --json` and `syntrop schedule list --json`.

---

## 5. Pairing with AI Coding Agents

Syntrop is designed to give AI coding agents persistent, verifiable operational memory.

### Agent entry points

- **Claude Code**: `CLAUDE.md` points to the canonical protocol.
- **Cursor**: `.cursor/rules/syntrop.mdc` supplies the project rule.
- **GitHub Copilot**: `.github/copilot-instructions.md` supplies repository instructions on supported surfaces.
- **Gemini CLI**: `GEMINI.md` is its default context entry point.
- **Codex**: `AGENTS.md` supplies repository instructions.
- **Antigravity / other runtimes**: manually ask the agent to read `AGENTS.md`; automatic discovery is unverified.

Confirm your runtime actually read `AGENTS.md`. The seven `skills/` files are read on demand through that protocol; they are not universally installed or auto-discovered. See [Agent Integration](agent-integration.md) for official discovery references and live-testing limits.

### The First Agent Prompt
Open your preferred coding agent inside this repository and paste:

> *"You are my executive operations partner using Syntrop.*  
> *1. Read `AGENTS.md` to understand your operational rules, deterministic CLI commands, and safety boundaries.*  
> *2. Run `syntrop doctor --json` to inspect our current workspace status.*  
> *3. Inspect relevant goals, projects, tasks, and commitments; identify evidence or choices needed before proposing a quarterly plan.*<br>
> *Constraint: Propose tasks for my review first. Do not commit state mutations to the database until I explicitly approve."*

A clear authorized request can proceed directly. A consequential plan may first need inspection or a recommendation. These are agent workflow choices, not new database statuses. Asking for a proposal does not authorize saving tasks or sessions. For later authorized updates, the agent reads state, uses `--expected-version` for supported updates to seen records, applies changes, validates, and reads them back; retry writes use `--idempotency-key`.

Core CLI commands do not invoke AI or send network requests. Explicit Google integration network operations are optional and separately authorized. Your agent runtime may use remote services; review its own privacy settings. Instruction files do not guarantee reasoning quality or autonomous continuity. [Behavior evaluations](../evals/README.md) describe what was and was not tested.

---

## 6. Backups and Data Sovereignty

Your data is stored in `~/.syntrop/data/life.db` under your full ownership.

To create a consistent, versioned backup bundle:
```sh
syntrop backup --to "$HOME/syntrop-backup-$(date +%Y%m%d)"
```
To restore a backup into a new workspace:
```sh
syntrop restore --from "$HOME/syntrop-backup-20261015" --workspace "$HOME/restored-syntrop"
```

For more details on CLI commands, refer to the [CLI Reference](cli-reference.md).


## 7. Optional Google Calendar & Tasks integration

After you have local work sessions, tasks, and habits, you can publish an approved projection to Google Calendar (**Syntrop · Focus**) and native Google Tasks (**Syntrop · Tasks** and **Syntrop · Habits**) without changing your offline workflow. Start with:

```sh
syntrop integration google setup
syntrop integration google status
```

`setup` without a client prints the onboarding steps and makes no network request. Follow the [Google Calendar & Tasks setup guide](integrations/google-calendar.md) to configure your Google Cloud Desktop OAuth client, consent in the system browser (`calendar.app.created` + `tasks`), configure presentation (`shortName`, `shortTitle`, custom `#RRGGBB` event labels) and habit task occurrences (`--mode tasks`), preview, and approve your sync. Checked-off tasks and habit occurrences in Google Tasks can be reconciled back into Syntrop via `syntrop integration google reconcile`. OAuth secrets and integration settings are kept outside workspace backups.
