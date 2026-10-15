# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

---

## Reporting a Vulnerability

We take the security of Syntrop and user operational privacy seriously.

If you discover a security vulnerability or accidental privacy exposure flaw, please **do not report it via public GitHub issues**.

Instead, please report security issues through **GitHub Private Vulnerability Reporting**:
1. Navigate to the repository's **Security** tab.
2. Under "Reporting", click **Report a vulnerability**.
3. Provide a clear description, reproduction steps, and potential impact.

If private vulnerability reporting is unavailable, reach out to the project maintainers directly via repository contact channels. You should receive an initial response acknowledging your report within 48 business hours.

---

## Security & Privacy Model

Syntrop is designed around strict local-first privacy and safety boundaries:

1. **Air-Gapped Execution**:
   - The Syntrop CLI makes zero outbound network requests and transmits no telemetry or user analytics.
   - All state operations occur locally on your machine via SQLite (`node:sqlite`).
2. **Physical Workspace Isolation**:
   - Private databases, journals, and notes reside strictly outside the application source checkout (default `~/.syntrop`).
   - The CLI actively rejects workspace initialization, backups, restores, or exports targeted inside the source code repository.
3. **Non-Destructive Generative Views**:
   - Views (`today`, `tomorrow`, `week`) write strictly to `views/generated/`.
   - User-supplied titles and descriptions are sanitized when rendering Markdown to prevent Markdown syntax corruption or malicious HTML injection.
4. **Agent Permissions**:
   - AI coding agents interact with Syntrop solely through the CLI command interface.
   - Agents should never be granted write permissions to raw database files.
