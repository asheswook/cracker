CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  credential_hash text NOT NULL REFERENCES credentials(token_hash),
  session_hash text REFERENCES browser_sessions(token_hash),
  installation_id uuid NOT NULL,
  subscription_cipher text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,credential_hash,installation_id)
);
CREATE TABLE notification_intents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid REFERENCES messages(id),
  outcome text NOT NULL CHECK(outcome IN ('succeeded','failed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES notification_intents(id),
  subscription_id uuid NOT NULL REFERENCES push_subscriptions(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','accepted','expired','invalid','suppressed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  accepted_at timestamptz,
  last_error text,
  UNIQUE(intent_id,subscription_id)
);
CREATE INDEX notification_dispatch ON notification_deliveries(next_attempt_at) WHERE state IN ('pending','leased');
