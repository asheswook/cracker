ALTER TABLE extension_skills ADD COLUMN archived_at timestamptz;
CREATE TABLE skill_versions (
 workspace_id uuid NOT NULL, skill_id uuid NOT NULL, revision integer NOT NULL,
 name text NOT NULL, description text NOT NULL, content text NOT NULL, content_hash text NOT NULL,
 origin_message_id uuid REFERENCES messages(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,skill_id,revision),
 FOREIGN KEY(workspace_id,skill_id) REFERENCES extension_skills(workspace_id,id)
);
INSERT INTO skill_versions(workspace_id,skill_id,revision,name,description,content,content_hash,created_at)
 SELECT workspace_id,id,revision,name,description,content,encode(sha256(convert_to(content,'UTF8')),'hex'),updated_at FROM extension_skills;
CREATE FUNCTION reject_skill_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Skill versions are immutable'; END $$;
CREATE TRIGGER skill_versions_immutable BEFORE UPDATE OR DELETE ON skill_versions FOR EACH ROW EXECUTE FUNCTION reject_skill_version_mutation();
ALTER TABLE schedules ADD COLUMN skill_id uuid, ADD COLUMN skill_revision integer,
 ADD CONSTRAINT schedules_skill_pair CHECK((skill_id IS NULL)=(skill_revision IS NULL)),
 ADD FOREIGN KEY(workspace_id,skill_id,skill_revision) REFERENCES skill_versions(workspace_id,skill_id,revision);
ALTER TABLE responsibilities ADD COLUMN skill_id uuid, ADD COLUMN skill_revision integer,
 ADD CONSTRAINT responsibilities_skill_pair CHECK((skill_id IS NULL)=(skill_revision IS NULL)),
 ADD FOREIGN KEY(workspace_id,skill_id,skill_revision) REFERENCES skill_versions(workspace_id,skill_id,revision);
CREATE TABLE skill_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 skill_id uuid NOT NULL, revision integer NOT NULL, vm_id uuid NOT NULL,
 task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), input_message_id uuid NOT NULL REFERENCES messages(id),
 kind text NOT NULL CHECK(kind IN ('test','scheduled')), client_execution_id uuid,
 loaded_at timestamptz, loaded_run_id uuid REFERENCES runs(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,client_execution_id),
 FOREIGN KEY(workspace_id,skill_id,revision) REFERENCES skill_versions(workspace_id,skill_id,revision),
 FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
CREATE TABLE skill_execution_checks (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, execution_id uuid NOT NULL REFERENCES skill_executions(id),
 criterion text NOT NULL, observed text NOT NULL, status text NOT NULL CHECK(status IN ('pass','fail','unknown')),
 source_message_id uuid NOT NULL REFERENCES messages(id), actor text NOT NULL DEFAULT 'user' CHECK(actor='user'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_execution_history ON skill_executions(workspace_id,skill_id,created_at DESC,id);
