-- The revision a draft was written from (the adapter's reading of the thread during the draft job), copied into the
-- send envelope at approval: sending compares the thread to what the user approved, not to what it is at send time.
ALTER TABLE attention_source_drafts ADD COLUMN revision text;
-- Check jobs keep their identity for life (the current check pointer moves on retries).
CREATE TABLE attention_source_check_tasks (
 task_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 send_task_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO attention_source_check_tasks(task_id, workspace_id, send_task_id)
SELECT check_task_id, workspace_id, task_id FROM attention_source_sends WHERE check_task_id IS NOT NULL ON CONFLICT DO NOTHING;
