# Development and tests

Use the checked toolchain: Bun 1.2.10, pnpm 10.33.2 and Node.js 24.7.0, with PostgreSQL 16+. Python 3 and Linux desktop tools are needed by selected execution/document tests. The Ubuntu service installer documents its exact system packages.

Use `.env` for local values. Bun reads it automatically. Configure `DATABASE_URL`, migrate an empty development database and run bootstrap once. The API binds to loopback port8787; Vite proxies `/v1` from port5173.

## Disposable PostgreSQL tests

Create a separate empty database, then set both variables to its connection URL. Never point tests at an existing user workspace: tests create, update and sometimes clean up fixture rows.

```sh
export TEST_DATABASE_URL='postgres://assistant:assistant@127.0.0.1:55439/assistant_test'
DATABASE_URL="$TEST_DATABASE_URL" bun scripts/migrate.ts
bun test tests
```

Some scenarios require optional native/Linux dependencies, a browser fixture, a VM or a live provider. Inspect a scenario before running it. `*-live.*` and `*.browser.*` are opt-in scripts, not default provider calls. Historical browser harnesses may require adapting local paths and browser setup; no private fixtures or authenticated sessions are supplied.

## Static checks

```sh
pnpm check
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm --dir apps/web build
gitleaks dir . --redact
```

Cloudflare bundle validation uses `pnpm exec wrangler deploy --dry-run`. Configure resource identifiers before a real deployment. Generated output, dependencies and runtime state are ignored by Git.

## Apple

See [the Apple build guide](../apps/apple/README.md). The checked-in project uses example identifiers and an empty development team. Unsigned compilation does not establish push delivery, App Store distribution, Gatekeeper acceptance or physical-device behavior.
