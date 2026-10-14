-- Short-lived control/daemon mailbox. OAuth tokens and proxy keys stay on the VM.
CREATE TABLE assistant.subscription_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES assistant.workspaces(id) ON DELETE CASCADE,
  vm_id uuid NOT NULL REFERENCES assistant.vms(id) ON DELETE CASCADE,
  command jsonb NOT NULL,
  callback_cipher text,
  claim_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 minute'
);
CREATE INDEX subscription_requests_pending ON assistant.subscription_requests(vm_id,created_at) WHERE status='pending';
