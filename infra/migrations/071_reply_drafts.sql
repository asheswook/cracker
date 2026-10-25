-- A reply draft job: one row per attempt to prepare a draft for a watched thread version. The task is recognised as a
-- draft job for its whole life (gating its output and pushes), and its outcome decides whether to retry.
CREATE TABLE attention_source_drafts (
 task_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 source_id uuid NOT NULL REFERENCES attention_sources(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES attention_source_items(id) ON DELETE CASCADE,
 source_revision integer NOT NULL,
 version text NOT NULL,
 -- dispatched | ready (card stored) | handled (already answered in the thread) | not_needed | failed | withdrawn
 state text NOT NULL DEFAULT 'dispatched' CHECK (state IN ('dispatched','ready','handled','not_needed','failed','withdrawn')),
 card_message_id uuid,
 note text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX attention_source_drafts_item ON attention_source_drafts(item_id, version);
-- A single look answers in the conversation that asked for it.
ALTER TABLE attention_source_runs ADD COLUMN conversation_id uuid, ADD COLUMN request_message_id uuid;
-- Items found by a single look may get a draft for a while without the standing watch.
ALTER TABLE attention_source_items ADD COLUMN once_until timestamptz;
-- A draft replaced because the thread changed (distinct from superseded = handled elsewhere).
ALTER TABLE card_states DROP CONSTRAINT card_states_state_check;
ALTER TABLE card_states ADD CONSTRAINT card_states_state_check CHECK (state IN ('pending','snoozed','accepted','resolved','failed','dismissed','superseded','replaced'));
ALTER TABLE attention_source_items DROP COLUMN draft_task_id;
