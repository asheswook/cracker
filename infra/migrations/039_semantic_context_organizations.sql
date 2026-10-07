CREATE TABLE semantic_context_organizations (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, operation_id uuid NOT NULL,
 actor_role text NOT NULL CHECK(actor_role IN ('client','vm')), actor_vm_id uuid,
 kind text NOT NULL CHECK(kind IN ('proposal','apply','undo')),
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), request jsonb NOT NULL, result jsonb NOT NULL,
 resolved_by uuid, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,operation_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_vm_id) REFERENCES vms(workspace_id,id),
 CHECK((actor_role='vm')=(actor_vm_id IS NOT NULL))
);
CREATE INDEX semantic_context_pending_proposals ON semantic_context_organizations(workspace_id,conversation_id,recorded_at,operation_id)
 WHERE kind='proposal' AND resolved_by IS NULL;
