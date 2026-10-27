SET search_path TO assistant, public;

CREATE TABLE meeting_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attendees)='array'),
  note_hint text NOT NULL DEFAULT '',
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','dispatched','done','skipped')),
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- timestamptz::date depends on the session timezone and cannot back an immutable index.
CREATE UNIQUE INDEX meeting_preps_event_day ON meeting_preps(workspace_id,event_key,((starts_at AT TIME ZONE 'UTC')::date));
CREATE INDEX meeting_preps_due ON meeting_preps(workspace_id,starts_at) WHERE state='planned';
CREATE UNIQUE INDEX meeting_preps_task ON meeting_preps(task_id) WHERE task_id IS NOT NULL;
