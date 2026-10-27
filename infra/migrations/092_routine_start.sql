ALTER TABLE assistant.responsibilities ADD COLUMN starts_at timestamptz;
-- Retain the reviewed occurrence so delayed delivery can still check its original evidence.
ALTER TABLE assistant.responsibility_evaluations ADD COLUMN review_at timestamptz;
