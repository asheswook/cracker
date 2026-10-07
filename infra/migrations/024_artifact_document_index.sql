CREATE TABLE artifact_search_jobs(
 artifact_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 extractor_version integer NOT NULL CHECK(extractor_version > 0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','failed','cancelled')),
 lease_id uuid,
 vm_id uuid,
 lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
 outcome text,
 completed_lease_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(artifact_id,extractor_version),
 FOREIGN KEY(workspace_id,artifact_id) REFERENCES artifacts(workspace_id,id),
 FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id),
 CHECK((status='leased')=(lease_id IS NOT NULL AND vm_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX artifact_search_due ON artifact_search_jobs(workspace_id,next_attempt_at) WHERE status='pending';
CREATE UNIQUE INDEX artifact_search_vm_lease ON artifact_search_jobs(vm_id) WHERE status='leased';
CREATE INDEX artifact_document_pending ON artifacts(workspace_id,created_at,id) WHERE state='ready' AND search_indexed=false;
UPDATE artifacts SET search_indexed=false WHERE state='ready' AND search_text IS NULL AND
 (media_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document') OR
 (media_type='application/octet-stream' AND lower(name) ~ '\.(pdf|docx)$'));
