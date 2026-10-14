# Third-party components

The MIT license at the repository root covers this project's original code. It does not relicense dependencies, platform SDKs, trademarks, service content or user-provided data.

JavaScript dependency versions are recorded in `pnpm-lock.yaml`; each dependency's package includes its license. Notable runtime components include React, Hono, Zod, Motion, PostgreSQL.js, the OpenAI and Anthropic SDKs, the MCP SDK, Playwright, Sharp and Werift. Development tools and their transitive dependencies also retain their licenses.

The Apple project resolves FirebaseCore and FirebaseMessaging through Swift Package Manager. Firebase SDK license and notice files remain with that dependency. Linux installation scripts install system packages, including Chromium-related tooling, FFmpeg and Xfce; those packages are distributed under their respective licenses and are not bundled here.

The web and app icons are generated from the character drawing in `apps/web/src/appearance/character-svg.ts` by `scripts/generate-icons.ts`. No screenshots, logos or downloaded assets from a reference product are included. Font dependencies are distributed through their packages with their own notices.

When distributing built applications, retain the license and notice files required by the actual dependency versions and bundled system components. This source snapshot does not bundle dependency binaries.
