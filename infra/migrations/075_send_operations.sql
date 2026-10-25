-- A send is one operation per approval, not per card: claimed once, executing until the adapter reports, and an
-- unknown outcome blocks every later send for the same thread until a read-only check settles it.
ALTER TABLE attention_source_sends DROP CONSTRAINT attention_source_sends_state_check;
ALTER TABLE attention_source_sends ADD CONSTRAINT attention_source_sends_state_check
  CHECK (state IN ('dispatched','executing','sent','not_sent','unknown','refused','checking'));
ALTER TABLE attention_source_sends ADD COLUMN recipient text, ADD COLUMN expected_messages integer, ADD COLUMN claimed_at timestamptz,
  ADD COLUMN attempted boolean NOT NULL DEFAULT false, ADD COLUMN check_task_id uuid;
CREATE UNIQUE INDEX attention_source_sends_one_open ON attention_source_sends(item_id) WHERE state IN ('dispatched','executing','unknown','checking');
-- A verified not_sent is the only thing that lets a card be approved again.
ALTER TABLE card_states ADD COLUMN retry_ok boolean NOT NULL DEFAULT false;
-- The text the user approved (possibly edited), so every device shows what was sent, not the original draft.
ALTER TABLE card_states ADD COLUMN approved_body text;
