-- Semantic ownership has been workspace-wide since 042. A claim's source
-- conversation need not be the conversation that originally created its context.
ALTER TABLE semantic_claims
 DROP CONSTRAINT semantic_claims_workspace_id_conversation_id_context_id_fkey;
ALTER TABLE semantic_claims
 ADD CONSTRAINT semantic_claims_workspace_context_fkey
 FOREIGN KEY(workspace_id,context_id) REFERENCES semantic_contexts(workspace_id,id);
