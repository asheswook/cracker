CREATE TABLE assistant.vm_model_defaults (
  vm_id uuid PRIMARY KEY REFERENCES assistant.vms(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES assistant.workspaces(id) ON DELETE CASCADE,
  configuration jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant.model_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES assistant.workspaces(id) ON DELETE CASCADE,
  vm_id uuid NOT NULL REFERENCES assistant.vms(id) ON DELETE CASCADE,
  selection jsonb NOT NULL,
  secret_cipher text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_revisions_latest ON assistant.model_revisions(vm_id,created_at DESC,id DESC);

CREATE TABLE assistant.run_models (
  run_id uuid PRIMARY KEY REFERENCES assistant.runs(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES assistant.model_revisions(id),
  selection jsonb NOT NULL,
  secret_cipher text
);
