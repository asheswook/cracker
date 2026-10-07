# Native refresh browser regression

From repository root: `node tests/native-app-refresh.browser.mjs`.

Requires installed workspace dependencies (`pnpm`, Bun), Chrome, and the installed OMO browser skill. No browser download or extra package installation is performed. Override `CHROME_PATH` for a different Chrome executable; override `OMO_BROWSER_SKILL_ROOT` for a different installed skill directory. The default skill location is `$HOME/.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser`.

The runner builds the current actual web app and actual hook into a temporary directory, starts its own synthetic HTTP fixture on an ephemeral localhost port, opens an isolated headless Chrome profile, and removes the server/build/profile even when browser startup fails. No existing service, login, app build, or `.local` fixture is required. It does not contact real providers or read user data.

The timeout scenario waits the real 30-second native bridge deadline. Other fault, lifecycle, and visibility scenarios are deterministic synthetic events; the visibility scenario overrides the document visibility value to test both branches in a real browser. It is not proof of actual iOS OS callbacks. Results, screenshots, build logs, and cleanup observables are saved under `.omo/evidence/native-resume-recovery/`; set `PHASE=some-name` to retain separate runs.

Expected suite: 9 scenarios pass. `CHROME_PATH=/does/not/exist PHASE=startup-failure node tests/native-app-refresh.browser.mjs` exercises cleanup after an expected browser startup failure and should exit nonzero.
