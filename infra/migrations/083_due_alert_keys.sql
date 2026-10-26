-- Due alerts are keyed by the obligation and its due date, not by a reading version: seeing a thread again or learning
-- its anchor later does not alert again, and a moved due date is a new alert (the old pending one is withdrawn).
ALTER TABLE attention_due_alerts ADD COLUMN due_at timestamptz;
UPDATE attention_due_alerts a SET due_at=i.due_at FROM attention_source_items i WHERE i.id=a.item_id;
ALTER TABLE attention_due_alerts DROP CONSTRAINT attention_due_alerts_pkey;
ALTER TABLE attention_due_alerts ADD COLUMN obligation text;
UPDATE attention_due_alerts a SET obligation=coalesce(i.category,'') FROM attention_source_items i WHERE i.id=a.item_id;
UPDATE attention_due_alerts SET obligation='' WHERE obligation IS NULL;
UPDATE attention_due_alerts SET due_at='epoch' WHERE due_at IS NULL;
ALTER TABLE attention_due_alerts ALTER COLUMN obligation SET NOT NULL, ALTER COLUMN due_at SET NOT NULL;
ALTER TABLE attention_due_alerts ADD PRIMARY KEY (item_id, obligation, due_at, stage);
-- The text the user was about to approve when a draft could not be verified, kept apart from their note.
ALTER TABLE attention_source_items ADD COLUMN reply_keep_body text;
