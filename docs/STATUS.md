# Snapshot status

Updated on 2026-10-07. This public source snapshot contains the web/Apple clients, control service, Linux daemon, semantic context backend and SQL migrations001–047.

## Present

- Continuous conversation, file attachments, computer viewer and configurable providers.
- Linux shell/file/computer tools, MCP connections and skills.
- Durable task and action records, scheduled work and notification integration.
- Source-backed context routing, bounded retrieval, note updates and revisioned reorganization/undo APIs.
- ChatGPT account connection, disconnection and reconnection settings; the native Mac app can select local-browser authentication or VM authentication.
- Recovery of interrupted provider/tool runs when new user input arrives, with account changes temporarily pausing run assignment.
- Experimental message reply metadata, reply-aware context selection and bounded automatic context correction policy.

## Incomplete

- Reply selection and thread UI.
- User-facing context merge/split/undo controls and proposal review.
- Completed product integration and long-term validation of automatic misclassification repair.
- Sufficient long-term scale/drift validation for large accumulated context collections.

Work-in-progress reply/context source is included to keep the public repository synchronized with development; inclusion does not establish feature completion. Existing conversations and private operational evidence are excluded. Prior deployment observations do not establish that a new installation or a different model/account will behave identically.

See `PUBLICATION_CHECKS.md` for checks actually run on this sanitized snapshot. Native distribution, physical-device UI, live provider connectivity and production infrastructure still require environment-specific validation.
