-- Every background task that was ever dispatched as a brief, so its output is recognised as a brief (and gated) even
-- after the day's brief row was re-planned or superseded by a settings change.
CREATE TABLE attention_brief_runs (
 task_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 local_date date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO attention_brief_runs(task_id, workspace_id, local_date)
SELECT task_id, workspace_id, local_date FROM attention_briefs WHERE task_id IS NOT NULL ON CONFLICT DO NOTHING;
-- 나중에 without a time: the card comes back when the next brief is dispatched (snoozed_until is only a fallback).
ALTER TABLE card_states ADD COLUMN snooze_next_brief boolean NOT NULL DEFAULT false;
