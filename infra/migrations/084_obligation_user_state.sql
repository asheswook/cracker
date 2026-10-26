-- What the user said about an obligation (a promise or a request) wins over later readings of the thread: a due date
-- they moved, and why it is blocked.
ALTER TABLE attention_source_items ADD COLUMN user_due_at timestamptz, ADD COLUMN blocked_reason text, ADD COLUMN blocked_at timestamptz;
