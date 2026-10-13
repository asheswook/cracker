# Snapshot status

Updated on 2026-10-13. This public source snapshot contains the web/Apple clients, control service, Linux daemon, semantic context backend and SQL migrations001–047.

## Present

- Continuous conversation, file attachments, computer viewer and configurable providers.
- Linux shell/file/computer tools, MCP connections and skills.
- Durable task and action records, scheduled work and notification integration.
- Source-backed context routing, bounded retrieval, note updates and revisioned reorganization/undo APIs.
- ChatGPT account connection, disconnection and reconnection settings; the native Mac app can select local-browser authentication or VM authentication.
- Recovery of interrupted provider/tool runs when new user input arrives, with account changes temporarily pausing run assignment.
- Bounded retries for transient provider request failures, preserving completed tool results, with cancellation and Retry-After support; infrastructure diagnostics use fixed exception/status fields without raw error contents.
- HTTP200 stream errors also enter bounded inference retry, including SDK errors without an HTTP status. Permanent authentication, quota and request-limit errors do not retry; diagnostics retain safe error codes, request IDs and opaque failure fingerprints.
- MCP request exceptions become redacted tool error results so the model can continue the same task. Transient annotated read-only calls retry once; uncertain mutations do not automatically replay. Transport errors retain the active tool catalogue until explicit removal or idle reconciliation.
- Expired, closed or timed-out remote MCP connections establish a fresh session before retry. Concurrent requests share reconnection while existing healthy calls drain; catalogues and read-only annotations must match before replay. Reconnection has time, pagination and retained-session limits with structured diagnostics.
- Desktop input ownership is separate from task execution: research, inference, file/shell work and child agents continue under user ownership; the model can explicitly request computer control when needed.
- Experimental message reply metadata, reply-aware context selection and bounded automatic context correction policy.

## Incomplete

- Reply selection and thread UI.
- User-facing context merge/split/undo controls and proposal review.
- Completed product integration and long-term validation of automatic misclassification repair.
- Sufficient long-term scale/drift validation for large accumulated context collections.
- Low-latency read acknowledgement: current read receipts follow semantic context preparation rather than initial runtime delivery.

Work-in-progress reply/context source is included to keep the public repository synchronized with development; inclusion does not establish feature completion. Existing conversations and private operational evidence are excluded. Prior deployment observations do not establish that a new installation or a different model/account will behave identically.

See `PUBLICATION_CHECKS.md` for checks actually run on this sanitized snapshot. Native distribution, physical-device UI, live provider connectivity and production infrastructure still require environment-specific validation.
