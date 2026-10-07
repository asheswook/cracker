ALTER TABLE semantic_search_state ADD COLUMN namespace_version integer NOT NULL DEFAULT 1 CHECK(namespace_version>0);
CREATE INDEX semantic_search_workspace_sequence ON semantic_search_documents(workspace_id,source_sequence);
CREATE INDEX semantic_search_workspace_tail ON semantic_search_documents(workspace_id,updated_at DESC,id);
