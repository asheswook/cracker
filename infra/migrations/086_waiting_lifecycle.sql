-- Waiting for someone else's answer is held until it arrives: since when (the asking message), when a follow-up may next
-- be offered, and what each draft/send was for (a reply to them, or a follow-up), so a follow-up never closes the wait.
ALTER TABLE attention_source_items ADD COLUMN waiting_since timestamptz, ADD COLUMN next_chase_at timestamptz;
ALTER TABLE attention_source_drafts ADD COLUMN purpose text NOT NULL DEFAULT 'reply' CHECK (purpose IN ('reply','chase','deliver'));
ALTER TABLE attention_source_sends ADD COLUMN purpose text NOT NULL DEFAULT 'reply' CHECK (purpose IN ('reply','chase','deliver'));
