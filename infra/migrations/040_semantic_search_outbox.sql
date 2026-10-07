CREATE TABLE semantic_search_outbox (
 id text PRIMARY KEY, workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, context_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id)
);
CREATE INDEX semantic_search_outbox_context ON semantic_search_outbox(workspace_id,context_id);
CREATE FUNCTION invalidate_semantic_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='messages' THEN source_id:=NEW.id; owner_id:=NEW.workspace_id;
 ELSIF TG_OP='DELETE' THEN source_id:=OLD.source_message_id; owner_id:=OLD.workspace_id;
 ELSE source_id:=NEW.source_message_id; owner_id:=NEW.workspace_id;
 END IF;
 UPDATE assistant.semantic_contexts c SET revision=revision+1,updated_at=now()
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
CREATE TRIGGER semantic_source_edited AFTER UPDATE OF content ON messages FOR EACH ROW WHEN(OLD.content IS DISTINCT FROM NEW.content) EXECUTE FUNCTION invalidate_semantic_source();
CREATE TRIGGER semantic_source_suppressed AFTER INSERT OR DELETE ON memory_suppressions FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_source();
CREATE TRIGGER semantic_retention_changed AFTER INSERT OR UPDATE OR DELETE ON memory_retention_decisions FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_source();
CREATE TRIGGER semantic_legacy_retention_changed AFTER INSERT OR UPDATE OR DELETE ON semantic_source_retention FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_source();
