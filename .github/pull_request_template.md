## Summary of Changes
A concise explanation of what this pull request introduces or fixes.

## Motivation & Context
Why is this change required? What issue does it resolve?

## Architectural Checklist
- [ ] Strictly zero new runtime npm dependencies (built exclusively on Node 24 core modules).
- [ ] No LLM API calls or non-deterministic logic introduced into the CLI write boundary.
- [ ] Preserves separation of public code from private workspaces (`~/.lifeos`).
- [ ] State mutations run inside SQLite `BEGIN IMMEDIATE` transactions.
- [ ] Timestamps require explicit ISO 8601 offsets.

## Verification & Testing
Describe the tests you ran to verify your changes:
- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm run format:check` passes.
- [ ] `npm test` passes all tests.
- [ ] Smoke tests run cleanly with disposable workspaces.

```sh
# Paste verification command output here
```
