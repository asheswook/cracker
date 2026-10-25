-- Draft jobs expire like observation runs; items remember the conversation that asked for the look that found them,
-- and the run that found them, so drafts and answers go back to the right place.
ALTER TABLE attention_source_drafts ADD COLUMN expires_at timestamptz;
UPDATE attention_source_drafts SET expires_at = created_at + interval '40 minutes' WHERE expires_at IS NULL;
ALTER TABLE attention_source_drafts DROP CONSTRAINT attention_source_drafts_state_check;
ALTER TABLE attention_source_drafts ADD CONSTRAINT attention_source_drafts_state_check
  CHECK (state IN ('dispatched','ready','handled','not_needed','failed','withdrawn','expired','send_failed'));
ALTER TABLE attention_source_items ADD COLUMN conversation_id uuid;
-- Requests that joined a look already in progress get its answer too.
ALTER TABLE attention_source_runs ADD COLUMN also_answer uuid[] NOT NULL DEFAULT '{}';
