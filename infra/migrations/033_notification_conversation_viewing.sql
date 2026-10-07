CREATE TABLE notification_conversation_viewing (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_hash text NOT NULL REFERENCES credentials(token_hash) ON DELETE CASCADE,
  session_hash text REFERENCES browser_sessions(token_hash) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  page_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK(sequence >= 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, installation_id, page_id)
);
CREATE INDEX notification_conversation_viewing_active
  ON notification_conversation_viewing(workspace_id, conversation_id, expires_at);
