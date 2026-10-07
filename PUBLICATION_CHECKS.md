# Publication preparation

Prepared on 2026-10-07 for the initial source publication. The snapshot uses an independent Git history; private working-directory history is not imported. Bun remains the runtime and test runner.

## Included and excluded

- MIT license, setup and architecture guides, contribution notes, example environment files and a pinned CI workflow.
- Existing backend and client code; interrupted reply/correction changes were replaced in this snapshot by their pre-change source copies. The original working directory still retains that unfinished work.
- Original operational documents, conversation exports, credentials, local VM/database state, screenshots, browser profiles, agent evidence, caches and signed application packages are excluded.
- Deployment IDs, account details, Apple team/bundle identifiers, local machine paths and production origin values were replaced with examples. One regression scenario uses synthetic library/calendar topics in place of the original task labels.
- Generated PDF/DOCX parser fixtures and app icons remain because they are part of source tests/builds. Binary fixtures are explicitly marked as binary in `.gitattributes`.

## Observed checks

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed; pnpm10.33.2, lockfile unchanged |
| Server TypeScript check | Passed |
| Cloudflare TypeScript check | Passed |
| Web production build | Passed |
| Worker bundle dry run | Passed; no deployment performed |
| SQL migrations001–044 on an empty isolated database | Passed |
| Context/conversation/MCP regression set | 150 passed,0 failed;870 assertions |
| Changed semantic/notification regression set | 27 passed,0 failed;128 assertions; overlaps the first set |
| Apple result-URL boundary executable | 14 scenarios passed |
| Ruby generator / JavaScript packaging syntax | Passed |
| CI YAML parsing | Passed |
| Staged whitespace check | Passed |
| Gitleaks8.30.1 staged-source scan | No secrets detected |
| Exact comparison against six locally configured secret values | No matches in publication files |
| Known personal/deployment identifier and forbidden-path audit | No findings |

The initial secret scan flagged a fixed synthetic test token. That fixture now generates a random test value while retaining the same redaction assertions; no scanner exclusion was added. The scanner binary was downloaded from its official release and checked against the published SHA-256 checksum.

## Development source synchronization (2026-10-07)

The subsequent synchronization includes current account settings, native Mac local-browser login, interrupted-run recovery, migrations 045–047, and experimental reply/context correction source. The initial publication exclusions for unfinished source no longer apply; the feature limitations in `docs/STATUS.md` still apply. Public environment examples, credential exclusions and portable Apple packaging configuration are retained.

Observed on the synchronized source:

- Server and Cloudflare TypeScript checks, web production build and Worker bundle dry run passed.
- Migrations 001–047 applied to a new isolated database.
- Context/conversation/MCP, account and interrupted-run regressions: 188 passed, 0 failed, 1,261 assertions across 31 files.
- An older reorganization test expected unconditional provisional moves. It now verifies the current evidence/confidence requirements, proposal fallback and undo, including rejection of invented evidence.
- Native Mac loopback executable passed callback, system-browser request, incorrect/duplicate state, foreign authorization, cancellation and cleanup scenarios.
- Ruby project generator and JavaScript packaging syntax checks passed.
- Source secret scan and comparison against six locally configured secret values found no matches; personal/deployment identifier and excluded-path checks found no findings.
- GitHub CI includes the account and interrupted-run regression set.

No production deployment, new signed Apple build or physical-device QA was performed as part of this Git synchronization.

## Limits

These checks apply to this source snapshot on the preparation machine. The full test suite, GitHub-hosted CI, a clean Linux installation, signed Apple builds, live providers, physical devices and a newly provisioned production deployment were not validated in this preparation. Secret scans reduce accidental disclosure risk; they are not a proof that arbitrary future changes contain no secrets.

The context/thread work listed as incomplete in [STATUS.md](docs/STATUS.md) remains incomplete. This publication preparation makes no additional product-completion claim.
