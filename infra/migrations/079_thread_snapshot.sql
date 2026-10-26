-- The last whole reading of a thread by the fixed adapter (per message: sender, time, recipients, body), so the feed
-- can show the conversation in place. Written only by the daemon from adapter output, never by the model.
ALTER TABLE attention_source_items ADD COLUMN thread_snapshot jsonb, ADD COLUMN thread_read_at timestamptz,
  -- A reply the user asked for from the feed, with what they want it to say (used by the next draft job).
  ADD COLUMN reply_note text;
