-- Lifecycle of a draft/choice card, so "나중에" is a snooze and an approval is tracked until its work finishes.
-- pending   : waiting for the user
-- snoozed   : the user said 나중에; comes back at snoozed_until (default: the next brief)
-- accepted  : the user answered; answer_message_id is the reply, task_id the work that carries it out
-- resolved  : that work finished (result_message_id is its report)
-- failed    : that work stopped without finishing
-- dismissed : the user does not want it any more (not shown again)
CREATE TABLE card_states (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 message_id uuid NOT NULL, block_id text NOT NULL CHECK (block_id ~ '^[a-z0-9_-]{1,32}$'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','snoozed','accepted','resolved','failed','dismissed')),
 option text, snoozed_until timestamptz,
 answer_message_id uuid, task_id uuid, result_message_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, message_id, block_id),
 FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE,
 CHECK ((state = 'snoozed') = (snoozed_until IS NOT NULL))
);
CREATE INDEX card_states_open ON card_states(workspace_id, state) WHERE state IN ('pending','snoozed','accepted');
CREATE INDEX card_states_task ON card_states(task_id) WHERE task_id IS NOT NULL;

-- Existing cards: pending unless a user answer exists (then accepted, or snoozed for a 나중에).
INSERT INTO card_states(workspace_id, message_id, block_id, state, created_at)
SELECT m.workspace_id, m.id, b->>'id', 'pending', m.created_at
FROM messages m, jsonb_array_elements(m.blocks) b
WHERE m.role = 'assistant' AND m.blocks IS NOT NULL AND b->>'kind' IN ('draft','choice')
ON CONFLICT DO NOTHING;
UPDATE card_states c SET
  state = CASE WHEN a.b->>'option' = 'later' THEN 'snoozed' ELSE 'accepted' END,
  option = a.b->>'option',
  snoozed_until = CASE WHEN a.b->>'option' = 'later' THEN a.created_at + interval '1 day' END,
  answer_message_id = a.id, task_id = a.task_id, updated_at = a.created_at
FROM (SELECT u.id, u.task_id, u.created_at, b FROM messages u, jsonb_array_elements(u.blocks) b WHERE u.role = 'user' AND u.blocks IS NOT NULL AND b->>'kind' = 'answer') a
WHERE c.message_id = (a.b->>'message_id')::uuid AND c.block_id = a.b->>'block_id';
