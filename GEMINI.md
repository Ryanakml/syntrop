# Syntrop instructions for Gemini CLI

Read [AGENTS.md](AGENTS.md) as the canonical cognitive routing and operational safety contract. Load only its relevant linked skills. This adapter does not install skills or enable tools/delegation; those capabilities depend on runtime configuration.

Use `syntrop --workspace PATH --json ...` (or `node src/cli.ts --workspace PATH --json ...`) for operational state. Never edit SQLite directly or place private workspace data in this checkout. Follow the canonical intent, readiness, authorization, and verification rules.
