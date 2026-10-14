# Parallel VM runs

Migration `059_parallel_runs.sql` and the session-aware daemon must be used together.
No deployment is performed by this change.

## Session, offer, acceptance and reconciliation

The daemon creates one UUID session at process startup. Runtime, model/account HTTP
clients and screen ICE requests share its `x-daemon-session` header. Registration
precedes model advertisement and recovery.

`POST /v1/daemon/session` submits the session UUID and the complete durable journal
snapshot (`accepted`, `executing`, `suspended`, or `terminal-pending`, with effect-safety
evidence). Registration locks the VM, increments its epoch, fences the previous
session, and reconciles before opening admission. Reusing a superseded session is
rejected. Ordinary polls never infer an orphan from missing or mismatched IDs.

Reported safe runs and pending terminal receipts are adopted; runs whose journal
does not prove safety are quarantined as `unknown`. Unaccepted offers missing from
the snapshot are transferred and offered again. A pending commentary message alone
is not terminal evidence. Missing accepted journal data is unsafe, not replayable.

A run row with `offered_at` and no `accepted_at` reserves capacity. Polls resend the
same run until accepted. The daemon persists the assignment in its SQLite journal
(`synchronous=FULL`) **before** posting `POST /v1/daemon/accept/:id`. Acceptance is
idempotent. No model or tool executes before ACK; failed ACK responses are retried
from durable acceptance without starting a second execution.
Recovery processes pending stop/control commands before starting accepted work.
An ACK for a cancelled/unknown run retires its local acceptance. ACK timeout/5xx
keeps acceptance durable for a later tick; transient control HTTP failures back off
without disconnecting healthy runs. Session fencing, authorization failures and
unconfirmed local input barriers still fail closed.
`stale_session`, HTTP 401 and HTTP 403 cause cleanup followed by a non-zero process
exit, not an endless reconnect loop using the same UUID. The supervisor starts a
fresh process/session. Registration 5xx logs `daemon.registration_retry` and backs
off without starting work.

Run mutations recheck the session under the VM lock, including idempotent event
replay. Run/context ownership also checks the session. Unregistered legacy VMs
remain serial; after a VM registers, token-only legacy requests are fenced. The
production entrypoint explicitly enables the session protocol.

## Admission and completion

`packages/protocol/parallel-runs.ts` contains the single `BACKGROUND_SLOTS` constant
(default `1`; `0` selects serial admission). Poll and resume/recovery use the shared
admission predicate under the VM lock. Foreground work has priority; within a lane
the order is `created_at,id`. One foreground and one background run may coexist,
including in the same conversation. Offers, paused runs and accepted runs reserve
their lane until terminal.

The foreground unique VM index and existing task unique index remain database
invariants. A VM-locked database trigger additionally enforces one background run.
The capacity trigger locks the VM only when a background run enters active capacity
(including INSERT or a lane/VM move), not for foreground or terminal transitions.
Stale-run recovery locks candidate VMs first and rechecks heartbeat/run state before
locking runs, matching event and registration lock order.
All existing-row transactions use the global order **workspace → VM → run →
conversation/task → child rows**. Workspace `FOR KEY SHARE` is taken before VM
locks in registration, events, resume, control requests/takeover, poll and recovery;
it conflicts with enrollment's workspace `FOR UPDATE` and pre-acquires the same
KEY SHARE mode as workspace FK checks needed to publish attention. Workspace and VM
sets are locked in sorted ID order.
Take workspace `FOR UPDATE` up front when a callback may later need that mode:
never hold VM/run locks and then upgrade a workspace lock. New-row admission may
select its queued task before inserting a new run, but touches no existing run out
of order. Drain schema bootstrap commits separately before ordered row mutations.
Task-specific stop commands exclude only their task; VM-wide control/account
barriers still block admission.

Runtime has one polling loop and a run registry with
`accepted → executing → finishing → terminal-acked` phases. An unconfirmed terminal
receipt does not free local capacity. Stop commands abort only their task's run.
Disconnect and shutdown drain every run, including cleanup failures.

The journal retains one outbox writer. A run-scoped flush waits for that run's
receipts, not an endless global queue. Failed delivery blocks later receipts for
that run within the pass but other runs progress. Permanent rejections retain
local evidence and fail the originating run, rather than poison other runs.
Within a run, side-effect-free mailbox/context reads and waits for idempotent outbox
receipts use abortable exponential backoff (250ms up to 5s) for transient control
errors. They resume at the same boundary: inference/run execution is not restarted
and completed tools are not replayed. Permanent validation/fencing errors do not
retry. Aborting a waiter does not cancel another run's shared outbox writer.

## Transactional ownership and Hyperdrive

Middleware is an early rejection check, not mutation authorization. The control
database adapter repeats session and run-owner validation **inside the mutation's
own transaction**, before calling protected context/memory APIs. The default writer
fence takes workspace `FOR KEY SHARE`, VM `FOR KEY SHARE`, then the owned run's
required lock; registration/adoption's VM `FOR UPDATE` cannot cross that commit.
Route profiles explicitly opt into stronger modes **up front**: composing uses VM
`FOR NO KEY UPDATE`, control/adoption callbacks use VM `FOR UPDATE`, and quota/
knowledge callbacks that themselves need workspace `FOR UPDATE` request it first.
Never pre-acquire VM/run SHARE then upgrade to UPDATE between concurrent callbacks.
Nested callbacks use the same transaction/savepoints; raw mutations are wrapped in
guarded transactions too. Artifact reserve/finalization and responsibility creation
also guard direct repository calls. A storage upload completed across rotation
cannot finalize with the old session; administrative lease cleanup handles it later.

Hyperdrive query caching applies only to read-only **non-transactional** queries.
Session reads used for authorization/fencing are inside explicit transactions,
including the middleware precheck and screen session checks; mutation fences also
take locking reads. A cached precheck must never authorize a later write. Keep these
transactions intact when changing routes. During rollout, verify old-session writes
are rejected immediately after rotation and verify Hyperdrive is not serving cached
session reads for these transaction paths. If a future session reader is moved
outside a transaction, disable caching for that path/binding before using it as a
fence. Local PostgreSQL tests do not verify production Hyperdrive configuration.

Daemon GET context/mailbox requests are reads, not workspace-wide mutations. The
hot `work_mailbox` payload is one SQL statement with VM and run session predicates
evaluated in the same snapshot as its messages, inside one short read-only
transaction (to bypass Hyperdrive caching). It has **no workspace/VM/run row locks**.
Measured including daemon authentication: 10 data SQL statements / 3 transactions
before this correction, 2 statements / 2 short transactions afterwards; the payload
alone fell from 9 statements to 1. Client REST authentication stays non-transactional.

Ordinary message/state/input/skill events use VM KEY SHARE and their own run lock;
**heartbeat events acquire VM NO KEY UPDATE before the run lock**, because their
`last_seen_at` write must not upgrade the VM after composing has locked VM → run.
The request profile and direct event repository share `eventVmLock` so the modes
cannot drift. Poll uses VM NO KEY
UPDATE for heartbeat/admission and does not lock all other active runs. Consequently
another run's in-flight event does not suppress heartbeat/command delivery through
SKIP LOCKED. Held mailbox reads do not block user append, takeover or another run's
events/composing. Read-only callbacks never take workspace UPDATE merely to fence.

### VM lock-mode and daemon GET audit

| Operation | Profile | VM mode acquired before run/child rows |
| --- | --- | --- |
| Message, state, input receipt, skill receipt events | mutation | KEY SHARE |
| Heartbeat event (with or without `run_id`) | mutation | NO KEY UPDATE |
| Composing | mutation | NO KEY UPDATE |
| Command ACK / session registration / resume / accept / control request | mutation or session | UPDATE |
| Poll heartbeat/admission | poll | NO KEY UPDATE |
| GET `/v1/daemon/model-account/callback` | **mutation**, despite GET | **UPDATE** (`localRequest` → `ownModelVm`) |
| GET `/v1/daemon/responsibilities` | mutation | SHARE (dispatch/evaluation work) |
| Other audited daemon GET readers | read | No writer row locks; read-only transaction fences |

The callback GET is a locking read, not a PostgreSQL READ ONLY transaction: account
ownership takes `FOR UPDATE` before decrypting the bound callback. Client account
status/authorization/subscription GETs have separate client routes and are not
daemon-read profiles. Daemon subscription has no GET handler. Proactive work,
work-search, memory persistence and semantic/structure daemon routers use POST.

The GET inventory test enumerates `createApp(...).routes` and exercises every mounted
daemon GET under its profile: poll/context, model-settings run/current, model-account
callback, extension catalogue/bound/skill, document-index content, artifact content,
and responsibility dispatch. Missing-resource/lease domain statuses are explicitly
listed; an unexpected new GET or a 500/25006 fails the test. The encrypted callback
also has a successful end-to-end local relay test. Audit each new GET handler down
to its repository before adding it to this inventory—HTTP GET alone is not evidence
that its transaction is read-only.

## Tools and shared desktop

Each run has a tool catalogue snapshot, scheduler, explicit output directory and
shell-session collection. Run cleanup cannot close another run's shell sessions.
Provider retry budgets remain arguments of each background model call.

All `computer`, `computer_exec`, `desktop_*` and built-in `browser_*` calls, including
observations, require the calling run's desktop lease. A busy call returns
`desktop_busy` without executing. `wait_for_desktop` is abortable and runs outside
exclusive scheduler slots. A grant requires a fresh observation. Foreground waiters
make idle background holders yield at an action boundary.
Idle expiry has a waiter-driven timer; a waiting run need not issue another tool to
wake it. Abort/revocation cancels the timer and cannot grant a lease afterwards.
Observation is enforced per run and lease generation: mutations return
`desktop_observation_stale` without executing until a successful current-generation
`desktop_get_app_state`, `desktop_query`, computer screenshot, `browser_snapshot`, or
image-returning `computer_exec` observation. Before observing, `computer_exec` is
limited to the canonical screenshot-only `return null;` script; arbitrary code must
wait for fresh observation. Desktop/browser references are invalidated on generation
change. Screen WebSocket upgrades verify daemon sessions, just like daemon REST;
the room rechecks at attach and closes fenced hibernated/live peers on frames or its
authorization alarm rather than letting an already-open socket bypass fencing.

Takeover revokes the lease and blocks new grants until return-control. Desktop
session resets are limited to its lease holder or the next leased session change;
starting/finishing unrelated work does not reset the desktop.

These are execution-resource boundaries, not an OS sandbox: shell and external MCP
tools still share the VM filesystem and must not bypass desktop ownership. A crashed
process's uncertain external effects require reconciliation; session fencing cannot
undo those effects. Operate one daemon process per VM, as before. Changing serial
mode while two runs are already reserved may require operator reconciliation of
the other reservation; it is not a live migration of two checkpoints into one slot.

## Rollout: drain before changing the Worker/daemon pair

Follow **pause admission → wait for active runs to finish → stop daemon → migrate →
deploy Worker → start daemon (same journal) → verify → unpause**. Do not replace or
delete the journal to get past reconciliation. These commands are operator guidance,
not actions performed by this change.

1. Report first, then explicitly pause each target VM:
   ```sh
   DATABASE_URL=... bun scripts/drain-runs.ts --vm <uuid>
   DATABASE_URL=... bun scripts/drain-runs.ts --vm <uuid> --pause
   ```
   Default is read-only reporting for all VMs. Mutations require `--vm <uuid>` or
   `--all`. The helper reports each VM's active runs (including offers and paused
   runs), lanes, offer/ACK timestamps and pending commands. It never changes run
   states or acknowledges commands.

   For a pre-059 database, pause bootstraps `vms.admission_paused` and a non-locking
   INSERT guard. This is necessary because the old serial Worker does not read the
   new flag: its poll holds the VM lock, so the guard blocks new assignments while
   existing runs keep completing. Legacy polls may log a database admission error
   while paused. Migration 059 preserves the bootstrapped flag and replaces the guard
   compatibly. Without this database guard, merely adding a boolean cannot drain an
   old Worker safely.

2. Repeat the report until `ready: true` (no active runs **and** no pending commands).
   Let existing offers be ACKed/re-sent and active checkpoints resume so they can
   finish; pause blocks *new* reservations, not completion of existing reservations.
   Resolve pending stop/control commands and investigate quarantined/uncertain work
   explicitly. Do not force `unknown` just to make the counter zero.
3. Explicitly stop the user service; do not merely kill a process that systemd may
   immediately restart:
   ```sh
   systemctl --user stop autonomous-assistant
   systemctl --user show autonomous-assistant -p ActiveState -p SubState -p MainPID -p NRestarts
   ```
   Confirm `ActiveState=inactive`, `MainPID=0`, and an unchanged `NRestarts` on a
   second observation after waiting. Confirm no timer/socket/external supervisor
   starts it again during rollout. Keep it stopped until the Worker deploy completes.
   Back up the **closed** journal at its configured `JOURNAL_PATH`, including any
   remaining `-wal`/`-shm` sidecars (or use a SQLite backup), and back up the database.
   Preserve the journal path and file permissions; never create an empty replacement.
4. Apply migration 059 using `DATABASE_URL=... bun scripts/migrate.ts`. Production has
   not applied 059 yet. If 059 already exists with an older checksum, stop here and
   prepare a separate production migration; never bypass checksum verification or
   recreate a production database. The disposable local `par_dev` was recreated only
   for this development correction.
5. Only after **059 is applied**, deploy the session-aware Worker and wait for that
   deployment to complete successfully. Do not start the daemon while the Worker
   deployment is in progress. Keep admission paused throughout this interval.
6. After the Worker deploy has completed, start the new daemon with the **same**
   journal path (`systemctl --user start autonomous-assistant`). Confirm session registration,
   reconciliation completion, command ACK delivery and screen connectivity. Verify
   no unexpected quarantines, no old-session activity, and foreground/background
   lane counts within capacity. Verify Hyperdrive's session-fencing reads are not
   cached, and inspect the report again. Admission remains paused until all these
   checks pass.
7. Only after verification, unpause each target:
   ```sh
   DATABASE_URL=... bun scripts/drain-runs.ts --vm <uuid> --unpause
   ```
   Confirm normal foreground admission and one-background-run capacity. On a failed
   rollout, leave admission paused and reconcile first; do not switch back to a
   token-only daemon after the VM has registered a fenced session.
