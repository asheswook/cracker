# Publication preparation

Prepared on 2026-10-07 for the initial source publication. The snapshot uses an independent Git history; private working-directory history is not imported. Bun remains the runtime and test runner.

## Included and excluded

- MIT license, setup and architecture guides, contribution notes, example environment files and a pinned CI workflow.
- Existing backend and client code; interrupted reply/correction changes were replaced in this snapshot by their pre-change source copies. The original working directory still retains that unfinished work.
- Original operational documents, conversation exports, credentials, local VM/database state, screenshots, browser profiles, agent evidence, caches and signed application packages are excluded.
- Deployment IDs, account details, Apple team/bundle identifiers, local machine paths and production origin values were replaced with examples. One regression scenario uses synthetic library/calendar topics in place of the original task labels.
- Generated PDF/DOCX parser fixtures and app icons remain because they are part of source tests/builds. Binary fixtures are explicitly marked as binary in `.gitattributes`.

## Observed checks

### Remote MCP connection recovery (2026-10-13)

- Actual socket-drop and expired-session regressions establish a new MCP session before the single safe retry. A failed mutation is not replayed; the next explicit call can use the new connection.
- Parallel calls, shared initialization, individual cancellation, removal during reconnect, authentication rejection, changed annotations, notifications and retained-generation limits are covered by real HTTP/SSE tests. Development and public checkouts each passed 73 tests with 5 Linux-only skips and 305 assertions across 10 files. TypeScript passed in both checkouts.
- The production daemon passed preflight after deploying the eight-file provider/MCP change; installed hashes match the frozen candidate. The existing stopped run resumed through the normal conversation endpoint, applied its new input and completed with a final assistant message. Its ten previously completed tool calls were not replayed.

### Provider stream recovery (2026-10-13)

- Real SDK HTTP200 error-frame reproductions failed before the fix and pass with bounded inference retries. Terminal response errors retain diagnostic metadata; permanent authentication, quota and incomplete-limit errors do not retry.
- Public-checkout provider and runtime-provider suite: 221 passed, 0 failed, 671 assertions across 21 files; server TypeScript check passed.
- A real runtime/SQLite/shell scenario confirms a completed shell effect executes once while the following failed inference retries with the identical request and completes the same run.
- An isolated probe using the existing app OAuth/model injected one stream failure, retried once, and received a real response with 43 tokens. It executed no tools and persisted no conversation messages. Error logs expose allowlisted codes, validated request IDs and hashes, not remote prose or credentials.

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

## Desktop ownership synchronization (2026-10-07)

The source now separates desktop input ownership from task execution and adds explicit model requests for computer control. Related regression tests and CI coverage are included. Portable configuration, private-data exclusions and unrelated development changes are preserved.

Observed on this public checkout: 157 tests passed with zero failures and 969 assertions across 20 files using real PostgreSQL and runtime HTTP/SQLite/shell fixtures. Root and control-service TypeScript checks passed. This synchronization does not change read-acknowledgement timing or claim a read-latency fix. Production execution under user ownership was observed separately; this Git synchronization does not deploy infrastructure or rebuild native applications.

## Provider retry synchronization (2026-10-07)

The source adds at most two retries for transient provider requests, abortable bounded backoff and Retry-After handling. Authentication, configuration, schema and signed context errors are excluded. Completed tools are outside the retry boundary. Failure and retry diagnostics retain fixed status/category fields without arbitrary upstream contents. CI includes the new regressions.

Observed on this public checkout: 189 tests passed, zero failures and 656 assertions across 23 files; strict TypeScript, CI YAML parsing and whitespace checks passed. Same-run recovery after a completed tool is verified through local HTTP/SQLite fixtures without repeating that tool. Separate deployment/live-provider evidence remains private; this Git synchronization does not deploy services or rebuild applications.

## MCP error continuation synchronization (2026-10-08)

Thrown MCP/transport errors now become redacted tool results rather than terminating inference. Annotated read-only, non-destructive transient calls retry once; uncertain mutations and unannotated calls do not automatically replay. Parent cancellation propagates, ordinary remote error results are preserved, and transport errors retain the active offered tool catalogue. CI includes real MCP wire and Runtime/SQLite regressions for this behavior.

Observed on this public checkout: 74 tests passed, zero failures, five Linux-only skips and 347 assertions across 12 files; strict TypeScript, CI YAML parsing, staged whitespace and staged-source secret checks passed. The new regression set contains 21 cases, including same-run continuation, healthy parallel siblings, cancellation and credential redaction. Seven unrelated existing full-suite failures were reproduced in the preceding unmodified public snapshot; this synchronization does not claim a full-suite pass. Private operational recovery, live model evidence and deployment state are excluded from the public commit.

## Limits

These checks apply to this source snapshot on the preparation machine. The full test suite, GitHub-hosted CI, a clean Linux installation, signed Apple builds, live providers, physical devices and a newly provisioned production deployment were not validated in this preparation. Secret scans reduce accidental disclosure risk; they are not a proof that arbitrary future changes contain no secrets.

The context/thread work listed as incomplete in [STATUS.md](docs/STATUS.md) remains incomplete. This publication preparation makes no additional product-completion claim.
