-- Observation runs carry the source revision they were started under; turning a watch off or changing it bumps the
-- revision, so a late report from an older run changes nothing. One-off checks run without enabling the watch.
ALTER TABLE attention_sources ADD COLUMN revision integer NOT NULL DEFAULT 1;
-- Coverage that is not complete yet: from pending_window_start (fixed) back to backfill_before (oldest fully read).
ALTER TABLE attention_sources ADD COLUMN pending_window_start timestamptz, ADD COLUMN backfill_before timestamptz;
ALTER TABLE attention_sources DROP CONSTRAINT attention_sources_health_check;
ALTER TABLE attention_sources ADD CONSTRAINT attention_sources_health_check CHECK (health IN ('ok','retrying','degraded','needs_user'));
ALTER TABLE attention_source_runs ADD COLUMN source_revision integer NOT NULL DEFAULT 1, ADD COLUMN expires_at timestamptz,
  ADD COLUMN once boolean NOT NULL DEFAULT false;
ALTER TABLE attention_source_runs DROP CONSTRAINT attention_source_runs_state_check;
ALTER TABLE attention_source_runs ADD CONSTRAINT attention_source_runs_state_check CHECK (state IN ('dispatched','complete','partial','failed','expired','withdrawn'));
UPDATE attention_source_runs SET expires_at = created_at + interval '40 minutes' WHERE expires_at IS NULL;
-- What the user has to do about a thread, the evidence for it, and the reply being prepared.
ALTER TABLE attention_source_items ADD COLUMN action text NOT NULL DEFAULT 'none' CHECK (action IN ('reply','review','act','none')),
  ADD COLUMN evidence text, ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN resolution text, ADD COLUMN resolution_note text,
  ADD COLUMN draft_task_id uuid, ADD COLUMN draft_version text, ADD COLUMN draft_message_id uuid;
-- A brief's input cut-off: news after it belongs to the next brief even if this one is published later.
ALTER TABLE attention_briefs ADD COLUMN snapshot_at timestamptz;
-- A card whose job was done elsewhere (the user replied in Gmail) is closed and can no longer be sent.
ALTER TABLE card_states DROP CONSTRAINT card_states_state_check;
ALTER TABLE card_states ADD CONSTRAINT card_states_state_check CHECK (state IN ('pending','snoozed','accepted','resolved','failed','dismissed','superseded'));
ALTER TABLE attention_source_items DROP CONSTRAINT attention_source_items_category_check;
ALTER TABLE attention_source_items ADD CONSTRAINT attention_source_items_category_check CHECK (category IN ('request','deadline','overdue','waiting','alert'));
ALTER TABLE attention_source_runs ADD COLUMN recheck_keys text[] NOT NULL DEFAULT '{}', ADD COLUMN oldest_read timestamptz;
