CREATE TABLE semantic_search_documents (
 id text PRIMARY KEY CHECK(length(id)=64), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 context_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('source','note')), reference_id uuid NOT NULL,
 source_sequence bigint NOT NULL, input_hash text NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL,
 vector jsonb NOT NULL CHECK(jsonb_typeof(vector)='array'), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id)
);
CREATE INDEX semantic_search_scope ON semantic_search_documents(workspace_id,conversation_id,source_sequence);
CREATE INDEX semantic_search_context ON semantic_search_documents(workspace_id,context_id);
CREATE INDEX semantic_search_tail ON semantic_search_documents(workspace_id,conversation_id,updated_at DESC);
CREATE TABLE semantic_search_state (
 workspace_id uuid NOT NULL, context_id uuid NOT NULL, conversation_id uuid NOT NULL,
 revision integer NOT NULL, through_sequence bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,context_id),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id)
);
