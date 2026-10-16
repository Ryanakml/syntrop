# Contributing to Syntrop

Thank you for your interest in contributing to Syntrop.

Syntrop is an open-source, local-first personal operations engine built for AI coding agents and human builders. We hold high standards for architectural simplicity, deterministic execution, and zero runtime dependencies.

---

## 1. Architectural Invariants

Before proposing changes, understand these non-negotiable architectural principles:
1. **Zero Runtime Dependencies**: The core CLI engine relies strictly on Node.js 24 built-in modules (`node:sqlite`, `node:fs`, `node:crypto`, `node:os`). Do not introduce external runtime npm packages.
2. **Deterministic Write Boundary**: The CLI is an air-gapped, deterministic state engine. It does **not** call LLM APIs, make external network requests, or run background daemon services. Cognitive reasoning belongs entirely in the calling agent runtime (guided by `AGENTS.md` and `skills/`).
3. **Physical Workspace Isolation**: The engine repository is distributable public code. Private user data (`data/life.db`, `knowledge/`, `journal/`) resides strictly in user-designated external directories (default `~/.syntrop`).
4. **ACID Transactions & DAG Validation**: Operational state is authoritative in SQLite. Prerequisite completion, cycle prevention, and schedule overlap avoidance are validated at transaction commit.

---

## 2. Development Setup

### Prerequisites
- **Node.js `>= 24.15.0 < 25`** (Node 24 LTS recommended):
  ```sh
  node -v
  # If needed:
  nvm install 24 && nvm use 24
  ```

### Getting Started
```sh
# 1. Clone your fork
git clone https://github.com/<your-username>/syntrop.git
cd syntrop

# 2. Install development tools (Prettier, TypeScript compiler, Node type definitions)
npm ci

# 3. Verify typechecking and tests
npm run typecheck
npm test

# 4. Optional: Link the CLI globally for manual testing
npm link
syntrop --help
# (Or using short alias: syn --help)
```

---

## 3. Testing and Code Quality

Every change must pass our automated quality gates:

```sh
# Run typechecking (noEmit)
npm run typecheck

# Check code formatting
npm run format:check

# Format files with Prettier
npm run format

# Run full test suite
npm test
```

### Writing Tests
- All automated tests use Node's native test runner (`node:test`) and live in `tests/*.test.mjs`.
- Always create isolated temporary workspaces using `mkdtempSync(join(tmpdir(), 'syntrop-test-'))`.
- Never run tests against real personal workspaces or create database files inside the repository checkout.

---

## 4. Good First Issues & Contribution Opportunities

We welcome contributions in the following areas:

1. **Shell Completion Scripts**:
   - Provide Bash, Zsh, and Fish tab completion generators for `syntrop` subcommands.
   - *Files*: `src/cli.ts`, new `completions/` directory.
2. **Additional Export Formats**:
   - Add CSV or iCalendar (`.ics`) export for calendar commitments and work sessions.
   - *Files*: `src/cli.ts`, `src/core.ts`.
3. **MCP Server Bridge**:
   - Create a lightweight Model Context Protocol (MCP) server adapter that translates MCP tool calls into `syntrop --json` invocations.
4. **Agent Skill Enhancements**:
   - Improve prompt clarity and operational checklists in `skills/` for new agent runtimes.

---

## 5. Pull Request Guidelines

1. **Keep PRs Focused**: A single PR should address one bug fix, feature, or documentation improvement.
2. **Document Intent**: Explain the motivation, affected commands, and testing evidence in your PR description.
3. **Preserve Schema Stability**: Any changes to `data/life.db` tables must include an incremental migration in `src/db.ts` with backwards compatibility tests.
4. **No Secret Leaks**: Ensure no private paths, personal logs, or database files are committed.
