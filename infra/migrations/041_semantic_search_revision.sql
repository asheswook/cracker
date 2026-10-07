ALTER TABLE semantic_contexts ADD COLUMN search_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE semantic_search_state ADD COLUMN search_revision bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION invalidate_semantic_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='messages' THEN source_id:=NEW.id; owner_id:=NEW.workspace_id;
 ELSIF TG_OP='DELETE' THEN source_id:=OLD.source_message_id; owner_id:=OLD.workspace_id;
 ELSE source_id:=NEW.source_message_id; owner_id:=NEW.workspace_id;
 END IF;
 UPDATE assistant.semantic_contexts c SET search_revision=search_revision+1
 WHERE c.workspace_id=owner_id AND EXISTS (
  SELECT 1 FROM assistant.semantic_context_links l JOIN assistant.messages m ON m.id=l.message_id AND m.workspace_id=l.workspace_id
  WHERE l.workspace_id=c.workspace_id AND l.context_id=c.id AND
   (l.message_id=source_id OR l.originating_message_id=source_id OR (
     TG_TABLE_NAME IN ('memory_retention_decisions','semantic_source_retention') AND
     EXISTS(SELECT 1 FROM assistant.messages origin WHERE origin.id=source_id AND origin.workspace_id=owner_id
       AND origin.conversation_id=m.conversation_id AND origin.task_id IS NOT DISTINCT FROM m.task_id)
   ))
 );
 RETURN NULL;
END $$;
