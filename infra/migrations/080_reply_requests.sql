-- One reply the user asked for from the feed, from request to result: a draft belongs to the request it was written
-- for, and a newer request makes older drafts unusable. A send remembers which request it answered, so a late result
-- closes only that request (not a newer one that arrived meanwhile).
ALTER TABLE attention_source_items ADD COLUMN reply_request_id uuid, ADD COLUMN reply_requested_at timestamptz;
ALTER TABLE attention_source_drafts ADD COLUMN reply_request_id uuid;
ALTER TABLE attention_source_sends ADD COLUMN request_anchor text, ADD COLUMN item_version text;
-- A look's thread readings, kept until its report creates the items they belong to.
ALTER TABLE attention_source_runs ADD COLUMN thread_snapshots jsonb NOT NULL DEFAULT '{}'::jsonb;
