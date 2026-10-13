# Architecture

The product keeps one continuous assistant conversation. Execution tasks, semantic contexts and the conversation are separate concepts: a task records an execution, while a context connects related retained messages across executions and conversations.

## Runtime

The React web client uses the control API for authenticated state and durable messages. The Apple applications host the same interface with native bridges for input, navigation and notifications. Cloudflare Workers run the control service; Durable Objects coordinate live rooms and computer signaling. PostgreSQL holds authoritative product state, R2 stores files and Vectorize supplies bounded semantic retrieval candidates.

A dedicated Linux daemon leases work, connects to the selected model provider, runs tools and journals effects locally. Desktop capture and input use the same VM as shell/file tools. Uncertain external effects remain unknown rather than being blindly replayed. Scheduled work uses database state and Cloudflare cron dispatch; Temporal is not required.

Desktop ownership gates mouse, keyboard and shared-browser mutations independently from task execution. Taking control interrupts and drains desktop operations while provider inference, research, file/shell work and child agents continue. The model uses `request_computer_control` for necessary desktop input; durable run-scoped commands settle ownership through daemon acknowledgements. New daemons opt into scoped ownership during polling and checkpoint resume, while legacy acknowledgements retain their prior behavior. Explicit stop and unconfirmed input-release failures still stop or quarantine execution.

## Context state

New retained user messages are routed against bounded candidate contexts. Candidate selection combines recent/lexical candidates with retrieval; the model does not receive every stored context. Retrieved evidence includes source identities and hashes. User statements, assistant-reported outcomes, decisions and constraints remain distinguishable.

Newly delivered messages enter an incremental metadata queue. The queue extracts notes from unprocessed source batches, records exact evidence, and retries idempotently. Corrections can supersede prior notes rather than silently rewriting the original messages. Context and search revisions invalidate derived retrieval state. Retention decisions remain authoritative when sources, notes and snapshots are read again.

Visible read receipts currently record application of input after synchronous semantic preparation. They are also used for completion and recovery checks; an initial delivery acknowledgement would need a separate record rather than prematurely inserting an application receipt.

Revisioned reorganization and undo APIs exist. They preserve original messages and record membership changes. This snapshot has no user-facing thread/correction panel and no finished automatic misclassification-repair lifecycle. Large dirty-context indexing is still an area for further scaling work.

## Configuration boundaries

Client sessions and VM credentials have different audiences. Provider, MCP and push secrets belong in protected local files or service secrets. Apple signing and Firebase files are supplied locally. A developer must provision their own resources; no operational accounts or data are distributed with the source.
