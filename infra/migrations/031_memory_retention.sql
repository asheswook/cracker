CREATE TABLE memory_retention_decisions (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('inherit','allow','deny_turn','deny_task')),
  quote text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,source_message_id),
  FOREIGN KEY (workspace_id,task_id) REFERENCES tasks(workspace_id,id),
  FOREIGN KEY (workspace_id,source_message_id) REFERENCES messages(workspace_id,id),
  CHECK ((action='inherit' AND quote IS NULL) OR (action<>'inherit' AND length(quote)>0))
);
CREATE INDEX memory_retention_task ON memory_retention_decisions(workspace_id,task_id);
