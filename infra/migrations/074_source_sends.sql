-- An approved reply to a watched thread is carried out by its own send job, fixed to what the user approved.
-- state: dispatched (the job runs) | sent (receipt with the approved body) | not_sent (the job proved nothing went out)
--        | unknown (it may have gone out: must be checked against the thread before any retry) | refused (the thread changed)
CREATE TABLE attention_source_sends (
 task_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 card_message_id uuid NOT NULL,
 block_id text NOT NULL,
 item_id uuid NOT NULL REFERENCES attention_source_items(id) ON DELETE CASCADE,
 account text NOT NULL, thread_key text NOT NULL, version text NOT NULL,
 body text NOT NULL, body_hash text NOT NULL,
 state text NOT NULL DEFAULT 'dispatched' CHECK (state IN ('dispatched','sent','not_sent','unknown','refused')),
 note text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX attention_source_sends_card ON attention_source_sends(card_message_id, block_id);
