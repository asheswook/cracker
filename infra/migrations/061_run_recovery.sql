ALTER TABLE runs ADD COLUMN recovery jsonb;
CREATE UNIQUE INDEX run_recovery_source ON runs((recovery->>'source_run_id')) WHERE recovery IS NOT NULL;
