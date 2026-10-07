ALTER TABLE workspaces ADD COLUMN onboarding_status text NOT NULL DEFAULT 'pending' CHECK(onboarding_status IN ('pending','completed','skipped'));
ALTER TABLE workspaces ADD COLUMN onboarding_updated_at timestamptz;
ALTER TABLE input_receipts ADD COLUMN applied_at timestamptz;
UPDATE input_receipts i SET applied_at=e.applied_at FROM (
  SELECT workspace_id,payload->>'run_id' AS run_id,payload->>'message_id' AS message_id,min(created_at) AS applied_at
  FROM events WHERE kind='input_applied' GROUP BY workspace_id,payload->>'run_id',payload->>'message_id'
) e WHERE e.workspace_id=i.workspace_id AND e.run_id=i.run_id::text AND e.message_id=i.message_id::text;
ALTER TABLE input_receipts ALTER COLUMN applied_at SET DEFAULT now();
CREATE INDEX input_receipts_message ON input_receipts(workspace_id,message_id,applied_at);
