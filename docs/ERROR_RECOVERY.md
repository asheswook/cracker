# Error recovery

The runtime distinguishes inference regeneration from replaying external actions.

- Invalid response envelopes, unknown tools, duplicate or reused call IDs, and invalid arguments reject the whole response before any call executes. The model receives structured validation feedback and can regenerate twice. A new real user message starts a fresh repair budget; restarting the daemon alone does not.
- Ordinary tool exceptions become structured tool results. Completed calls stay in the transcript. A failed mutation is labelled uncertain and is not automatically replayed. Cancellation and execution-cleanup failures still stop execution.
- A provider request rejected before any response (HTTP 400/413/422, excluding account errors) does not stop the run. Images added since the last accepted response are removed, the model receives `provider_request_rejected` feedback, and the request is regenerated. Two consecutive rejections without an accepted response fall through to normal failure handling.
- Provider failures retain the existing bounded provider retry policy. Final failure diagnostics are appended only to a recoverable checkpoint. Permanent account errors still require account repair.
- Recovery discovery uses unapplied same-task user input, independent of the error's prose and whether the input arrived before or after the failure.
- Safe checkpoints resume the same run. Missing, damaged or uncertain checkpoints create a new explanation-only run with no tools. The old run and action journal remain unchanged. The replacement preserves the model binding and records its predecessor; repeated requests return the same replacement.
- Explanation-only completion remains a failed task, not a claim that the original external operation succeeded. New messages can start ordinary work afterward.
- Success and failure acknowledgements both reject termination while input remains unapplied. Validation exhaustion and refusal return to the mailbox when this happens.

Migrations 061 and 062 add persistent recovery metadata, enforce one explanation per predecessor, and allow a new active run beside a historical unknown run for the same task. Active runs remain unique per task.

## Input intake and steering

Received messages are ingested as a batch and their read receipts are queued before slow context selection. Pending context source IDs are checkpointed and prepared on resume, including when the saved cursor already covers those messages. Receipt enqueue precedes checkpoint advancement so a restart cannot skip an unacknowledged input.

While semantic preparation or model inference is active, daemon polling checks for newer input. It cancels only that preparation/inference request, consumes the new input, and regenerates the response. Before consuming new input, interrupted inference preserves the received, replayable output prefix in the checkpoint. OpenAI reasoning must arrive in a completed `response.output_item.done` item with encrypted content; Claude thinking must have its signature and completed block. Unfinished thinking and tool arguments are excluded. A trailing partial text block is retained as an interrupted draft, not published as an answer. A final mailbox check applies the same preservation when a response finishes just before new input is noticed.

Every preserved tool call is paired with an explicit `executed:false` result; none is dispatched. Claude's output and native signed context are checkpointed together without rewriting their prefix. Snapshot readers are isolated per provider attempt and frozen at cancellation, so retry failures and late buffered events cannot contaminate the retained context. A persisted response identifier prevents duplicate preservation after recovery. Explicit stop/disconnect still takes precedence over steering preservation. Completed external actions remain intact, and tool execution is not cancelled by this mechanism.

Continuation checkpoint writes occur outside the inference cancellation handler. A storage failure is reported through normal runtime failure handling and prevents another inference; it cannot be mistaken for a successful steering cancellation.

Native token counting and compaction still finish before their existing mailbox refresh; this does not provide atomic ordering between the final mailbox check and server message insertion. Continuation support follows the provider wire formats: [OpenAI streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), and [Claude prefix preservation](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

## Implementation references

Reviewed on 2026-10-18; these are moving source links, not vendored implementations:

- [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts): tool preparation and execution failures become error tool results and join the conversation.
- [OpenCode session processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts) and [retry policy](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts): tool failure recording is distinct from bounded provider retries.
- [Codex tool handlers](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mod.rs): argument failures use `FunctionCallError::RespondToModel`.

These references support model-visible error handling. Durable input receipts, checkpoint safety and concurrent terminal acknowledgements are verified by this repository's own tests rather than inferred from those projects.

## Regression coverage

`control-validation-retry.test.ts` exercises arbitrary error categories, input arriving before failure, idempotent replacement creation and terminal input guards against PostgreSQL. `journal-failure-feedback.test.ts` verifies safe feedback persistence and corrupt/uncertain checkpoints. `runtime-tool-failure-recovery.test.ts` uses actual HTTP and shell operations to check single execution of uncertain mutations and tool-free explanations. `runtime-failed-receipt-recovery.test.ts` injects input at failed-acknowledgement boundaries and verifies bounded retries without new input.
