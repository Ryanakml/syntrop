# GitHub Copilot Instructions for Syntrop

- **System Context**: Syntrop is a local-first personal operations engine built in TypeScript on Node.js 24 using native `node:sqlite`.
- **Architectural Separation**: The code repository is public and distributable; personal workspaces (default `~/.syntrop`) are isolated and never placed inside the git checkout.
- **Write Boundary**: All state mutations must be performed via the CLI (`src/cli.ts` or `syntrop` / `syn`) with `--json`. Never execute raw SQL queries or manual file modifications on `data/life.db`.
- **DAG Tasks & Invariants**: Tasks form a Directed Acyclic Graph. Cycle checks and foreign key validations run inside SQLite `BEGIN IMMEDIATE` transactions.
- **Time Representation**: All timestamps require explicit ISO 8601 offsets (e.g. `2026-10-15T09:00+07:00`) and use half-open intervals `[start, end)`.
- **Safety First**: Do not embed personal paths, credentials, or private notes in code, documentation, or tests.
