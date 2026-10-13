# Deployment

## Cloudflare

Create your own PostgreSQL database/Hyperdrive binding and R2 bucket. Install pgvector 0.8 or newer on PostgreSQL and grant the migration role permission to `CREATE EXTENSION IF NOT EXISTS vector` (or have an administrator enable it first in `assistant` or `public`). Copy `wrangler.jsonc` to the ignored `wrangler.local.jsonc` and update its example identifiers and names. The all-zero Hyperdrive ID is deliberately not a real resource. The provision worker configuration also contains an example ID.

Semantic recall uses PostgreSQL as its only vector store. Migration 045 converts existing JSON arrays in place to `vector(1024)` and builds a cosine HNSW index; allow time and an exclusive table lock for the conversion before deploying the new worker. The dimension matches the fixed Workers AI `@cf/baai/bge-m3` model and its validated output. Keep the Workers AI binding for embeddings and classification. The cron still embeds stale contexts using revision checks; it no longer delivers vectors to an external index.

Apply the SQL migrations through a PostgreSQL connection before serving requests. Configure Worker secrets with Wrangler, including the extension encryption key, provider settings and optional notification/TURN settings appropriate to your deployment. The server code validates each enabled integration's configuration. Never paste secret values into a tracked configuration file.

```sh
pnpm exec wrangler deploy --config wrangler.local.jsonc --dry-run
# After configuring your resources and reviewing the output:
pnpm exec wrangler deploy --config wrangler.local.jsonc
```

The worker serves the web build and API, uses Durable Objects for live coordination, and runs a one-minute dispatch cron. TURN relay is required for reliable computer viewing across restrictive or external networks; configure your own relay credentials and validate actual media delivery.

## Linux execution computer

Use a dedicated Ubuntu24.04 VM with Bun, pnpm and Node.js. Run `sh infra/linux/install-user-service.sh --install-deps` as the dedicated VM user. This installs system packages, prepares the desktop and user services, but does not start the daemon automatically.

Edit `~/.config/autonomous-assistant/daemon.env` with your control URL, VM ID, VM credential and explicitly selected provider. Start the service using the command printed by the installer. The VM includes Xfce, terminal and file manager support; shell/file tools operate in this same environment.

Treat access to the daemon as access to that VM. Validate browser, shell, file, computer input, reconnect and backup/recovery behavior in your own environment before unattended use.

## Apple and notifications

Set your application origin, unique bundle IDs and Apple team in the Xcode project. Add your own Firebase configuration under ignored `apps/apple/LocalConfiguration/{ios,macos}/GoogleService-Info.plist`. APNs keys and signing certificates remain outside Git. Enable and test notification permissions on each target device.

Export plist files are templates. Replace `YOURTEAMID` where present before export. Mac direct distribution requires Developer ID signing and notarization; iOS/TestFlight requires your own App Store Connect app and provisioning. No signed binary or preconfigured production push account is included.
