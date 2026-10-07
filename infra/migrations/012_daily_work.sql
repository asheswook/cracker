ALTER TABLE responsibility_actions ADD COLUMN scheduled_for timestamptz;
CREATE UNIQUE INDEX responsibility_daily_occurrence ON responsibility_actions(responsibility_id,scheduled_for) WHERE scheduled_for IS NOT NULL;
