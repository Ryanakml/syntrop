# Syntrop instructions for Claude Code

Read [AGENTS.md](AGENTS.md) as the canonical cognitive routing and operational safety contract before using Syntrop. Load only the relevant linked skills; do not assume a request for a plan authorizes persistence. Runtime tools, research, and delegation are optional capabilities, not supplied by Syntrop.

All operational reads and writes use `syntrop --workspace PATH --json ...` (or `node src/cli.ts --workspace PATH --json ...`). Never edit SQLite directly or place private workspace data in this checkout. Follow the canonical verification and authorization boundaries.
