ALTER TABLE schedules ADD COLUMN management_revision integer NOT NULL DEFAULT 0;
ALTER TABLE responsibilities ADD COLUMN management_revision integer NOT NULL DEFAULT 0;
ALTER TABLE proactive_mutations ADD COLUMN request jsonb;
