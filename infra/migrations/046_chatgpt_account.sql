CREATE TABLE assistant.chatgpt_accounts (
  vm_id uuid PRIMARY KEY REFERENCES assistant.vms(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES assistant.workspaces(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','disconnected','connected','requires_login','connecting')),
  request_id uuid,
  action text CHECK(action IN ('connect','disconnect')),
  request_status text CHECK(request_status IN ('pending','running','completed','failed')),
  error_code text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((request_id IS NULL)=(action IS NULL)),
  CHECK((request_id IS NULL)=(request_status IS NULL))
);
