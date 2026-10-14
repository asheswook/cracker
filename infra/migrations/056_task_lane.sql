ALTER TABLE assistant.tasks ADD COLUMN lane text NOT NULL DEFAULT 'foreground' CHECK (lane IN ('foreground','background'));
UPDATE assistant.tasks SET lane='background' WHERE origin<>'user';
ALTER TABLE assistant.runs ADD COLUMN lane text NOT NULL DEFAULT 'foreground' CHECK (lane IN ('foreground','background'));
UPDATE assistant.runs r SET lane=t.lane FROM assistant.tasks t WHERE t.id=r.task_id;
CREATE FUNCTION assistant.inherit_run_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT lane INTO NEW.lane FROM assistant.tasks WHERE id=NEW.task_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_lane BEFORE INSERT ON assistant.runs FOR EACH ROW EXECUTE FUNCTION assistant.inherit_run_lane();
DROP INDEX assistant.task_active;
CREATE UNIQUE INDEX task_foreground_active ON assistant.tasks(conversation_id) WHERE lane='foreground' AND state NOT IN ('cancelled','succeeded','failed','unknown');
-- Dispatch holds the schedule/action row lock and marks it delivered/dispatched in the creation transaction.
ALTER TABLE assistant.messages ADD COLUMN hidden boolean NOT NULL DEFAULT false;
