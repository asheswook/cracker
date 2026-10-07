ALTER TABLE memories ADD CONSTRAINT memories_workspace_identity UNIQUE(workspace_id,id);
CREATE TABLE memory_corrections(
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  root_memory_id uuid NOT NULL,
  supersedes_id uuid NOT NULL,
  conversation_id uuid,
  actor_credential_hash text NOT NULL REFERENCES credentials(token_hash),
  typed_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,supersedes_id),
  FOREIGN KEY(workspace_id,id) REFERENCES memories(workspace_id,id),
  FOREIGN KEY(workspace_id,root_memory_id) REFERENCES memories(workspace_id,id),
  FOREIGN KEY(workspace_id,supersedes_id) REFERENCES memories(workspace_id,id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
  CHECK(id<>supersedes_id AND id<>root_memory_id)
);
CREATE INDEX memory_corrections_root ON memory_corrections(workspace_id,root_memory_id);
