ALTER TABLE vms ADD COLUMN daemon_session_id uuid;
ALTER TABLE vms ADD COLUMN daemon_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE vms ADD COLUMN daemon_reconciled boolean NOT NULL DEFAULT false;
ALTER TABLE vms ADD COLUMN IF NOT EXISTS admission_paused boolean NOT NULL DEFAULT false;
CREATE TABLE daemon_sessions (
  id uuid PRIMARY KEY,
  vm_id uuid NOT NULL REFERENCES vms(id),
  epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(vm_id,epoch)
);
ALTER TABLE runs ADD COLUMN daemon_session_id uuid REFERENCES daemon_sessions(id);
ALTER TABLE runs ADD COLUMN offered_at timestamptz;
ALTER TABLE runs ADD COLUMN accepted_at timestamptz;
DROP INDEX run_vm_active;
CREATE UNIQUE INDEX run_vm_foreground_active ON runs(vm_id)
  WHERE lane='foreground' AND state NOT IN ('cancelled','succeeded','failed','unknown');
CREATE FUNCTION enforce_run_background_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lane<>'background' OR NEW.state IN ('cancelled','succeeded','failed','unknown') THEN
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND OLD.lane='background' AND OLD.vm_id=NEW.vm_id
    AND OLD.state NOT IN ('cancelled','succeeded','failed','unknown') THEN
    RETURN NEW;
  END IF;
  PERFORM id FROM assistant.vms WHERE id=NEW.vm_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM assistant.runs WHERE vm_id=NEW.vm_id AND id<>NEW.id AND lane='background'
      AND state NOT IN ('cancelled','succeeded','failed','unknown')) THEN
    RAISE EXCEPTION 'Background run capacity exhausted' USING ERRCODE='23505',CONSTRAINT='run_vm_background_capacity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER z_run_background_capacity BEFORE INSERT OR UPDATE OF state,lane,vm_id ON runs
  FOR EACH ROW EXECUTE FUNCTION enforce_run_background_capacity();
-- The non-locking guard also permits a pre-057 serial Worker to be drained safely.
-- Poll already holds the VM lock, so pausing admission serializes with its INSERT.
CREATE OR REPLACE FUNCTION assistant.enforce_admission_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT admission_paused FROM assistant.vms WHERE id=NEW.vm_id) THEN
    RAISE EXCEPTION 'VM admission is paused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS a_run_admission_pause ON assistant.runs;
CREATE TRIGGER a_run_admission_pause BEFORE INSERT ON assistant.runs
  FOR EACH ROW EXECUTE FUNCTION assistant.enforce_admission_pause();
