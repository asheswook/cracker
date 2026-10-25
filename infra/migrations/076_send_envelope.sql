-- The send envelope is checked against adapter facts, not model text: the exact recipient address and the thread
-- revision the adapter computed (message count | last sender | last time). Checks of unknown sends retry a bounded
-- number of times and then ask the user to look.
ALTER TABLE attention_source_sends ADD COLUMN recipient_address text, ADD COLUMN revision text, ADD COLUMN check_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE attention_source_sends DROP CONSTRAINT attention_source_sends_state_check;
ALTER TABLE attention_source_sends ADD CONSTRAINT attention_source_sends_state_check
  CHECK (state IN ('dispatched','executing','sent','not_sent','unknown','refused','checking','needs_user'));
DROP INDEX attention_source_sends_one_open;
CREATE UNIQUE INDEX attention_source_sends_one_open ON attention_source_sends(item_id) WHERE state IN ('dispatched','executing','unknown','checking','needs_user');
-- The adapter revision of an item at the time its draft was written (sending re-checks against it).
ALTER TABLE attention_source_items ADD COLUMN revision text;
-- What the adapter actually covered in a look (list calls), so "complete" is not wider than what was read.
ALTER TABLE attention_source_runs ADD COLUMN adapter_coverage jsonb NOT NULL DEFAULT '[]'::jsonb;
