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
git clone https://github.com/Ryanakml/syntrop.git
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
syntrop doctor
```
Expected output:
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

# 3. Query next unblocked actions (Task 2 is blocked, so only Task 1 appears!)
syntrop task next

# 4. Schedule a focused work session
syntrop schedule add --task <TASK_1_ID> --start 2026-10-15T09:00+07:00 --end 2026-10-15T10:00+07:00

# 5. Inspect today's operational agenda
syntrop today
```

---

## 5. Pairing with AI Coding Agents

Syntrop is designed to give AI coding agents persistent, verifiable operational memory.

### Supported Agent Runtimes
- **Google Antigravity / Gemini CLI**: Natively reads `AGENTS.md`.
- **Claude Code**: Uses `CLAUDE.md` to discover instructions and skills.
- **Cursor**: Uses `.cursor/rules/syntrop.mdc`.
- **OpenAI Codex**: Uses `AGENTS.md` and `skills/`.

### The First Agent Prompt
Open your preferred coding agent inside this repository and paste:

> *"You are my executive operations partner using Syntrop.*  
> *1. Read `AGENTS.md` to understand your operational rules, deterministic CLI commands, and safety boundaries.*  
> *2. Run `syntrop doctor --json` to inspect our current workspace status.*  
> *3. Help me plan my quarterly goals and outline our active projects.*  
> *Constraint: Propose tasks for my review first. Do not commit state mutations to the database until I explicitly approve."*

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
