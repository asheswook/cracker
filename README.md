# Autonomous Assistant

A self-hosted personal assistant with a continuous conversation, a dedicated Linux computer, persistent context, scheduled work, MCP connections, and configurable skills.

The web client runs in a browser or the included iOS/macOS WebKit shells. A Cloudflare Worker coordinates PostgreSQL-backed state and a Linux daemon executes tools, shell commands, file operations, and computer interaction.

This is a development snapshot. See [current status and limitations](docs/STATUS.md) before deploying it. Experimental reply metadata and context correction source are included; reply/thread UI and long-term correction validation remain incomplete.

## Components

| Directory | Responsibility |
| --- | --- |
| `apps/web` | React conversation, computer viewer and settings |
| `apps/apple` | SwiftUI/WebKit shells, native input and notification integration |
| `services/control` | Hono API, sessions, durable work state and screen signaling |
| `services/daemon` | Linux execution, provider connections and durable action journal |
| `packages/context` | Source-backed semantic contexts, bounded retrieval and revisioned reorganization |
| `packages` | Tools, MCP/skills, artifacts, memory, notifications and provider adapters |
| `infra` | PostgreSQL migrations, Cloudflare configuration and Linux services |
| `tests` | Unit, database, protocol and opt-in browser/live scenarios |

## Local development

Checked toolchain: Bun 1.2.10, pnpm 10.33.2 and Node.js 24.7.0. Use PostgreSQL 16+. Desktop execution requires a separate Ubuntu 24.04 VM; the control API and web interface can run locally without starting the daemon.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Edit DATABASE_URL in .env for an empty development database.
bun scripts/migrate.ts
bun scripts/bootstrap.ts
pnpm dev
```

In a second terminal:

```sh
pnpm --dir apps/web dev
```

Open the URL printed by Vite. Bootstrap writes separate client and VM credentials to `.local/connection.json` with restrictive file permissions. Use the client credential to establish a browser session; configure the VM credential only on the daemon. Bootstrap refuses to overwrite an existing connection file.

Configure a provider available to your account. API and ChatGPT authentication paths are explicit; a paid API is not used as an automatic fallback. Provider availability, OAuth access and model identifiers depend on your account.

## Checks

```sh
pnpm check
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm --dir apps/web build
```

Database tests must use a **separate disposable database**. See [development and tests](docs/DEVELOPMENT.md) for migration and execution commands. Browser/live probes require their documented fixtures and are not substitutes for physical-device testing.

## Setup guides

- [Architecture and context lifecycle](docs/ARCHITECTURE.md)
- [Development and tests](docs/DEVELOPMENT.md)
- [Cloudflare, Linux and Apple setup](docs/DEPLOYMENT.md)
- [Apple application build](apps/apple/README.md)
- [Contribution guidelines](CONTRIBUTING.md)

Deployment names and identifiers are examples. Supply your own database, Cloudflare resources, credentials, Apple identifiers and Firebase configuration. Private conversation exports, operational evidence, credentials and app binaries are excluded.

## License

[MIT](LICENSE). Dependencies retain their own licenses; see [third-party components](THIRD_PARTY_NOTICES.md).
