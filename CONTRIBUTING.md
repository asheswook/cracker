# Contributing

Use the pinned pnpm lockfile and existing strict TypeScript/Bun conventions. Keep PostgreSQL as the source of truth. Preserve message identity, source retention, revision checks and execution idempotency when changing persistence or recovery.

Run the type checks, web build and relevant tests in [DEVELOPMENT.md](docs/DEVELOPMENT.md). Use a disposable database and synthetic fixtures. Explain what was observed on a real surface separately from mocked or unit-test behavior.

Do not submit credentials, personal conversations, browser profiles, screenshots of private workspaces, database dumps, operational logs, signing certificates, or Firebase configuration. `.gitignore` prevents accidental inclusion of common local files but is not a secret scanner. Run `gitleaks dir . --redact` before publishing changes.

Keep changes scoped, record user-visible behavior and relevant validation, and preserve accessibility, native input and scroll continuity when changing the UI. Private deployment scripts and production access are not required to contribute.
