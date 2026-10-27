SET search_path TO assistant, public;

ALTER TABLE meeting_preps ADD COLUMN delivered boolean NOT NULL DEFAULT false;
ALTER TABLE meeting_preps ADD COLUMN message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
-- Recover publication status for notes delivered before this migration.
UPDATE meeting_preps p SET delivered=true,message_id=m.id FROM messages m
WHERE p.task_id=m.task_id AND p.workspace_id=m.workspace_id AND p.state='done'
  AND m.role='assistant' AND NOT m.hidden AND m.phase='final_answer';

CREATE TABLE meeting_prep_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  half text NOT NULL CHECK (half IN ('morning','afternoon')),
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(workspace_id,local_date,half)
);
-- Keep superseded attempts classified as brief/silent even after a meeting is re-armed.
CREATE TABLE meeting_prep_tasks (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  meeting_prep_id uuid NOT NULL REFERENCES meeting_preps(id) ON DELETE CASCADE
);
INSERT INTO meeting_prep_tasks(task_id,workspace_id,meeting_prep_id)
SELECT task_id,workspace_id,id FROM meeting_preps WHERE task_id IS NOT NULL;
