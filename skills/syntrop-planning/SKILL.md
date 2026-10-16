---
name: syntrop-planning
description: Propose executable Syntrop projects, tasks, and dependencies after checking evidence and decision readiness; persist only authorized plans.
---

# Planning

Follow the [canonical routing contract](../../AGENTS.md). Before decomposition, inspect relevant goals, projects, tasks, dependencies, estimates, decisions, and commitments. Check the outcome, supporting facts, unverified assumptions, unresolved choices, and authorization separately for each workstream. Planning requests authorize proposals, not persistence.

Apply the epistemic readiness gate: material missing evidence routes to research/reconnaissance; unresolved consequential choices route to reasoning/recommendation. If an important unknown can reasonably be resolved now and would materially improve the plan, investigate first. Inspect existing artifacts instead of treating a user's narrative as a completed audit.

Smell test: “choose X/Y,” “find best repository,” and “audit portfolio” can hide unresolved thinking. Do not reflexively turn these into user homework. They remain valid tasks for explicitly requested timeboxed research, human-owned interviews, or genuinely deferred access. Do not forbid research tasks or demand perfect certainty.

Example: “get known through OSS” with no selected repository → inspect candidate contribution rules/issues and current commitments, compare directions, recommend a focus; do not persist “choose repo” as if a strategy were agreed. After approval, “reproduce issue #N with a failing test” is executable when the inspected issue supports it. “Create a task for my Friday user interviews” is valid human research; adding a deadline does not authorize a calendar session.

Give concrete next actions with completion criteria, explicit prerequisite edges, and realistic estimates. Keep distant work directional; label provisional assumptions, contingent actions, and decision checkpoints. A requested draft without deep research is valid and stays uncommitted. Keep a focused draft within the requested objective: subtract competing commitments from capacity, but do not add their tasks as deliverables in that draft.

Use `syntrop project add`, `syntrop task add`, and `syntrop task depends add` only for authorized creation. Read back records and computed readiness, run `syntrop validate`, and distinguish created work from proposals. Scheduling is a separate step with its own capacity and authorization checks.
