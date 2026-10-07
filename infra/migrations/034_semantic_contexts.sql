CREATE TABLE semantic_contexts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160), scope text NOT NULL CHECK(length(scope) BETWEEN 1 AND 1200),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), source_sequence bigint NOT NULL,
 initiating_message_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id,initiating_message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE INDEX semantic_context_recent ON semantic_contexts(workspace_id,conversation_id,source_sequence DESC);
CREATE TABLE semantic_context_sources (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, message_id uuid NOT NULL, sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,message_id,sha256),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE TABLE semantic_context_links (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, message_id uuid NOT NULL, context_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('provisional','confirmed')),
 source_sequence bigint NOT NULL, source_sha256 text NOT NULL, evidence jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,message_id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,message_id,source_sha256) REFERENCES semantic_context_sources(workspace_id,message_id,sha256)
);
CREATE INDEX semantic_context_link_recent ON semantic_context_links(workspace_id,context_id,source_sequence DESC);
CREATE TABLE semantic_context_link_revisions (
 workspace_id uuid NOT NULL, message_id uuid NOT NULL, revision integer NOT NULL,
 context_id uuid NOT NULL, source_sha256 text NOT NULL, payload jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id,revision),
 FOREIGN KEY(workspace_id,message_id) REFERENCES messages(workspace_id,id)
);
CREATE TABLE semantic_context_notes (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, context_id uuid NOT NULL,
 context_revision integer NOT NULL CHECK(context_revision>0), kind text NOT NULL CHECK(kind IN ('fact','decision','open_question','constraint','outcome')),
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 1200), evidence jsonb NOT NULL,
 basis text NOT NULL CHECK(basis IN ('user_statement','assistant_report','system_record')),
 source_message_id uuid NOT NULL, source_sha256 text NOT NULL, source_sequence bigint NOT NULL,
 supersedes uuid REFERENCES semantic_context_notes(id), superseded_by uuid REFERENCES semantic_context_notes(id),
 valid_from timestamptz, valid_to timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<=valid_to),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,source_message_id,source_sha256) REFERENCES semantic_context_sources(workspace_id,message_id,sha256)
);
CREATE INDEX semantic_context_note_active ON semantic_context_notes(workspace_id,context_id,context_revision DESC) WHERE superseded_by IS NULL;
CREATE TABLE semantic_context_mutations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), operation_id uuid NOT NULL, vm_id uuid NOT NULL,
 request_hash text NOT NULL, request jsonb NOT NULL, result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,operation_id), FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
