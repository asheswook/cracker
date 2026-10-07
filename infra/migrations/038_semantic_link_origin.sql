ALTER TABLE semantic_context_links ADD COLUMN originating_message_id uuid;
ALTER TABLE semantic_context_links ADD CONSTRAINT semantic_context_link_origin_scope
 FOREIGN KEY(workspace_id,conversation_id,originating_message_id)
 REFERENCES messages(workspace_id,conversation_id,id);
