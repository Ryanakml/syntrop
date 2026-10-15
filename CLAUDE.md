# Syntrop Instructions for Claude Code

You are interacting with a repository that uses **Syntrop** for deterministic personal operations and agent execution memory.

## Authoritative Specification
Always follow the operating guidelines, CLI interaction boundaries, and safety rules defined in [AGENTS.md](AGENTS.md).

## Core Principles
1. **Deterministic Write Boundary**: All database inspection and mutation MUST go through the CLI using `--json`:
   ```sh
   syntrop --workspace PATH --json <command>
   # or via short alias / direct node:
   syn --workspace PATH --json <command>
   node src/cli.ts --workspace PATH --json <command>
   ```
2. **Never edit `data/life.db` directly** via SQL or sqlite shell. SQLite is the single authority of operational state.
3. **Intent Recognition**:
   - Discussion/questions -> reasoning & evidence.
   - Proposing plans -> structured proposals.
   - Authorized changes -> atomic CLI execution with `--idempotency-key` and `--expected-version`.
4. **Specialized Skills**: Refer to the focused skill guides in `skills/`:
   - `skills/lifeos-planning/SKILL.md` — Goal decomposition, DAG task dependencies, readiness checks.
   - `skills/lifeos-scheduling/SKILL.md` — Session scheduling, conflict rejection, and calendar commitments.
   - `skills/lifeos-habits/SKILL.md` — Habit definition, frequency targets, and occurrence logging.
   - `skills/lifeos-reflection/SKILL.md` — Objective weekly reviews, variance analysis (actual vs planned).
   - `skills/lifeos-research/SKILL.md` — Fact-finding, evidence preservation with sources and timestamps.
   - `skills/lifeos-reasoning/SKILL.md` — Consequential decisions recorded via `syntrop decision add`.
5. **Validation**: Verify database consistency after mutations using `syntrop validate`.
