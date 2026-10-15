# Agent Integration & Compatibility Guide

Syntrop is an **agent-agnostic personal operations engine**. It gives AI coding agents persistent, verifiable operational memory while maintaining strict local-first safety.

---

## 1. How an Agent Operates

1. **Protocol Discovery**: The agent reads [AGENTS.md](../AGENTS.md) at the repository root to understand operating constraints, CLI boundaries, and safety policies.
2. **Deterministic Inspection**: State is inspected strictly via `syntrop --json <command>` (or `node src/cli.ts --json <command>`). JSON responses provide predictable schemas and structured error codes.
3. **Intent-Driven Interaction**:
   - **Discussion**: The agent reasons using user context and relevant skills.
   - **Proposals**: The agent outlines plans, DAG task sequences, and schedule proposals for user critique.
   - **Authorized Execution**: Only when the user explicitly approves, the agent runs CLI mutations.
4. **Concurrency & Idempotency**:
   - For update mutations, the agent passes `--expected-version <version>` to guard against stale updates.
   - For retries, the agent passes `--idempotency-key <key>` to ensure side-effect safety.
5. **Decisions as Invariants**: Approved technical or strategic conclusions are committed via `syntrop decision add`, permanently linking rationale to projects.

---

## 2. Hub-and-Spoke Configuration Across AI Agents

Different coding agents discover project instructions through different conventions. Syntrop implements a **Single Source of Truth** architecture:

```
                      ┌──────────────────────────────┐
                      │    AGENTS.md (Canonical)     │
                      └──────────────┬───────────────┘
                                     │
       ┌──────────────────┬──────────┴──────────┬──────────────────┐
       ▼                  ▼                     ▼                  ▼
┌──────────────┐   ┌──────────────┐      ┌──────────────┐   ┌──────────────┐
│  CLAUDE.md   │   │ .cursor/     │      │ .github/     │   │ Codex/Gemini │
│ (Claude Code)│   │  rules/      │      │  copilot-    │   │ (Direct root │
│              │   │  syntrop.mdc │      │  instructions│   │  discovery)  │
└──────────────┘   └──────────────┘      └──────────────┘   └──────────────┘
```

### Supported Platforms & Setup

| Agent Runtime | Integration File | Configuration Mechanism |
| :--- | :--- | :--- |
| **Google Antigravity / Gemini CLI** | `AGENTS.md` | Automatically loads `AGENTS.md` and repository skills. |
| **OpenAI Codex** | `AGENTS.md` & `skills/` | Natively reads `AGENTS.md`. To use skills globally outside this repo: `mkdir -p ~/.codex/skills && ln -s "$(pwd)/skills/"* ~/.codex/skills/`. |
| **Claude Code** | `CLAUDE.md` | Automatically detected by Claude Code CLI on startup. Directs Claude to `AGENTS.md`. |
| **Cursor (Agent / Composer)** | `.cursor/rules/syntrop.mdc` | Project rule file with `alwaysApply: true`. Directs Cursor to CLI boundaries. |
| **GitHub Copilot Chat** | `.github/copilot-instructions.md` | Contextual prompt injection into Copilot Chat. |

---

## 3. Specialized Agent Skills

Syntrop includes six focused operational skills in `skills/`:

- [lifeos-planning](../skills/lifeos-planning/SKILL.md): Goal-to-task decomposition, DAG dependency validation, and task readiness.
- [lifeos-scheduling](../skills/lifeos-scheduling/SKILL.md): Work session allocation, calendar commitment management, and half-open conflict checks.
- [lifeos-habits](../skills/lifeos-habits/SKILL.md): Habit design, target tracking, and occurrence logging.
- [lifeos-reflection](../skills/lifeos-reflection/SKILL.md): Weekly reviews, scheduled vs actual time analysis, and objective reflection.
- [lifeos-research](../skills/lifeos-research/SKILL.md): External fact-finding and evidence gathering with observation dates and source URLs.
- [lifeos-reasoning](../skills/lifeos-reasoning/SKILL.md): Evaluating complex trade-offs, opportunity costs, and committing `decision add`.

---

## 4. Cold-Start Agent Prompt Example

To start a new session with any compatible agent:

```markdown
You are my personal operations partner using Syntrop.
1. Read AGENTS.md to understand your operational constraints and the CLI boundary.
2. Run `syntrop doctor --json` to verify workspace status.
3. Review my current goals with `syntrop goal list --json` and active projects with `syntrop project list --json`.
4. Check next actionable tasks using `syntrop task next --json`.
5. Propose recommendations for today's focus. Do not commit database mutations until authorized.
```
