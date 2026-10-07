CREATE TABLE proactive_mutations (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  client_action_id uuid NOT NULL,
  vm_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,client_action_id),
  FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
