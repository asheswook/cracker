-- Workspace attention policy and the daily brief, owned by the assistant (not a user-registered trigger).
CREATE TABLE attention_settings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 timezone text NOT NULL DEFAULT 'Asia/Seoul',
 -- The brief is on by default. brief_at_minute is an explicit time the user asked for (minutes after local midnight);
 -- NULL means the assistant chooses from the user's own morning pattern.
 brief_enabled boolean NOT NULL DEFAULT true,
 brief_at_minute integer CHECK (brief_at_minute BETWEEN 0 AND 1439),
 quiet_start_minute integer NOT NULL DEFAULT 1320 CHECK (quiet_start_minute BETWEEN 0 AND 1439),
 quiet_end_minute integer NOT NULL DEFAULT 480 CHECK (quiet_end_minute BETWEEN 0 AND 1439),
 source_message_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- One brief per local day.
-- planned    : chosen time not reached yet (settings_at = the settings revision it was planned from)
-- dispatched : a background run is writing it; it must publish before expires_at
-- delivered  : its body was stored (message_id) and one push was queued; snapshot = what it covered
-- skipped    : nothing new since the last delivered brief, too late, quiet, or the run said NO_REPORT
-- failed / expired : the run stopped, or came back after expires_at (the late body is not published)
CREATE TABLE attention_briefs (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 local_date date NOT NULL,
 state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','dispatched','delivered','skipped','failed','expired')),
 planned_at timestamptz NOT NULL,
 planned_minute integer NOT NULL,
 reason text NOT NULL,
 settings_at timestamptz NOT NULL,
 task_id uuid,
 message_id uuid,
 snapshot jsonb,
 dispatched_at timestamptz,
 expires_at timestamptz,
 finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, local_date)
);
CREATE INDEX attention_briefs_due ON attention_briefs(planned_at) WHERE state = 'planned';
CREATE UNIQUE INDEX attention_briefs_task ON attention_briefs(task_id) WHERE task_id IS NOT NULL;

-- Cards approved before 066 whose work already ended were left as accepted: settle them now.
UPDATE card_states c SET
  state = CASE WHEN t.state = 'succeeded' AND (b.b->>'kind' = 'choice' OR EXISTS (
            SELECT 1 FROM messages r WHERE r.workspace_id = c.workspace_id AND r.task_id = c.task_id AND r.role = 'assistant'
              AND r.blocks @> '[{"kind":"result"}]' AND (r.blocks @> '[{"action":"sent"}]' OR r.blocks @> '[{"action":"posted"}]')))
          THEN 'resolved' ELSE 'failed' END,
  updated_at = now()
FROM tasks t, messages m, jsonb_array_elements(m.blocks) b(b)
WHERE c.state = 'accepted' AND t.id = c.task_id AND t.state IN ('succeeded','failed','cancelled')
  AND m.workspace_id = c.workspace_id AND m.id = c.message_id AND b.b->>'id' = c.block_id;
