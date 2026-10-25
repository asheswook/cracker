-- "Already answered, don't ask again": an item remembers the incoming message that created the obligation and, when
-- closed, the later reply that answered it. A new request reopens with a new anchor; a thank-you does not.
ALTER TABLE attention_source_items ADD COLUMN request_anchor text, ADD COLUMN handled_evidence text, ADD COLUMN resolution_basis text;
