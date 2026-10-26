# Third-party components

The MIT license at the repository root covers this project's original code. It does not relicense dependencies, platform SDKs, trademarks, service content or user-provided data.

JavaScript dependency versions are recorded in `pnpm-lock.yaml`; each dependency's package includes its license. Notable runtime components include React, Hono, Zod, Motion, PostgreSQL.js, the OpenAI and Anthropic SDKs, the MCP SDK, Playwright, Sharp and Werift. Development tools and their transitive dependencies also retain their licenses.

The Apple project resolves FirebaseCore and FirebaseMessaging through Swift Package Manager. Firebase SDK license and notice files remain with that dependency. Linux installation scripts install system packages, including Chromium-related tooling, FFmpeg and Xfce; those packages are distributed under their respective licenses and are not bundled here.

## Components used by the Linux VM

| Component | License | How it is used |
| --- | --- | --- |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) v8.0.28 by Luis Pater | MIT | Subscription model proxy. The installer downloads the official release binary of that tag and keeps its LICENSE beside it. Not included in this repository. |
| [open-computer-use](https://github.com/iFurySt/open-codex-computer-use) 1.1.0 by Leo | MIT | Desktop control MCP server, installed from npm by `--install-deps`. |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | Browser tools, an npm dependency. |

Thanks to these authors; their licenses and copyright notices apply to their code, not this project's MIT license.

## Dependency licenses

Licenses other than MIT/ISC/BSD/Apache-2.0 in the dependency tree:
- `@fontsource-variable/geist` (SIL OFL 1.1): font shipped with the web app; the OFL permits bundling and redistribution with the license kept.
- `lightningcss`, `mediabunny` (MPL-2.0): unmodified; their source is available from their projects.
- `@img/sharp-libvips-*` (LGPL-3.0-or-later): prebuilt libvips loaded dynamically by Sharp, unmodified, used on the server/daemon side only.
- `caniuse-lite` (CC-BY-4.0): build-time browser data.
- `react-doctor`, `oxlint-plugin-react-doctor` (Million Software's modified MIT): a development-only audit tool (`pnpm --dir apps/web audit:react`), not shipped. Its license requires written permission before using that package's own source as AI training/evaluation data or selling it as a hosted product; this project does neither.

The web and app icons are generated from the character drawing in `apps/web/src/appearance/character-svg.ts` by `scripts/generate-icons.ts`. No screenshots, logos or downloaded assets from a reference product are included. Font dependencies are distributed through their packages with their own notices.

When distributing built applications, retain the license and notice files required by the actual dependency versions and bundled system components. This source snapshot does not bundle dependency binaries.
