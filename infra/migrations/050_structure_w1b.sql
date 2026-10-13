-- Axis A remains the primary edge; a branch is an independent, one-hop span.
-- No owning-topic tables or ownership updates: these are provisional annotations.
ALTER TABLE semantic_exchange_edges DROP CONSTRAINT semantic_exchange_edges_relation_check;
ALTER TABLE semantic_exchange_edges ADD CONSTRAINT semantic_exchange_edges_relation_check CHECK(relation IN ('follow_up','challenge','apply_example','correction','instruction','new_topic'));
ALTER TABLE semantic_exchange_edges ADD COLUMN subject_action text CHECK(subject_action IN ('same_subject','new_subject_branch','return_to_region','new_root'));
ALTER TABLE semantic_exchange_edges ADD COLUMN proposed_subject text CHECK(char_length(proposed_subject) BETWEEN 1 AND 80);
ALTER TABLE semantic_exchange_edges ADD COLUMN subject_confidence numeric CHECK(subject_confidence BETWEEN 0 AND 1);
-- A valid continuation may refer to an exchange which has no answer yet.
ALTER TABLE semantic_exchange_edges ADD COLUMN continuation_exchange_id uuid;
ALTER TABLE semantic_exchange_edges ADD FOREIGN KEY(workspace_id,continuation_exchange_id) REFERENCES semantic_exchanges(workspace_id,id);
ALTER TABLE semantic_exchange_edges ADD COLUMN branch_from jsonb CHECK(branch_from IS NULL OR jsonb_typeof(branch_from)='object');
ALTER TABLE semantic_exchange_edges ADD COLUMN return_region_ref uuid;
ALTER TABLE semantic_exchange_edges ADD COLUMN return_evidence jsonb CHECK(return_evidence IS NULL OR jsonb_typeof(return_evidence)='object');
ALTER TABLE semantic_exchange_edges ADD COLUMN reference_evidence jsonb CHECK(reference_evidence IS NULL OR jsonb_typeof(reference_evidence)='object');
ALTER TABLE semantic_exchange_edges ADD FOREIGN KEY(workspace_id,return_region_ref) REFERENCES semantic_exchanges(workspace_id,id);
-- Preserve a null-anchor instruction on axis A. Locate the old composite CHECK
-- by its definition rather than relying on PostgreSQL's generated ordinal name.
DO $$ DECLARE name text; BEGIN
 SELECT conname INTO STRICT name FROM pg_constraint WHERE conrelid='assistant.semantic_exchange_edges'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%target_start IS NULL%';
 EXECUTE format('ALTER TABLE assistant.semantic_exchange_edges DROP CONSTRAINT %I',name);
END $$;
ALTER TABLE semantic_exchange_edges ADD CONSTRAINT semantic_edge_window CHECK(
 (state='linked' AND target_exchange_id IS NOT NULL AND relation IS NOT NULL AND target_message_id IS NOT NULL AND target_source_sha256 IS NOT NULL AND target_start IS NOT NULL AND target_end IS NOT NULL AND target_start>=0 AND target_end>target_start) OR
 (state<>'linked' AND target_exchange_id IS NULL AND target_message_id IS NULL AND target_source_sha256 IS NULL AND target_start IS NULL AND target_end IS NULL AND NOT is_return)
);
-- The original trigger handles axis A. Invalidate additional evidence and its
-- owning task on retention changes, without dirtying unrelated new turns.
CREATE FUNCTION invalidate_structure_w1b() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; source_id uuid;
BEGIN
 IF TG_OP='DELETE' THEN owner_id:=OLD.workspace_id; ELSE owner_id:=NEW.workspace_id; END IF;
 IF TG_TABLE_NAME='messages' THEN source_id:=NEW.id;
 ELSIF TG_OP='DELETE' THEN source_id:=OLD.source_message_id; ELSE source_id:=NEW.source_message_id; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text||':semantic-structure',0));
 UPDATE assistant.semantic_exchange_edges e SET needs_revalidation=true WHERE e.workspace_id=owner_id AND (EXISTS(
  SELECT 1 FROM (VALUES(e.branch_from),(e.return_evidence),(e.reference_evidence)) span(value)
  JOIN assistant.semantic_exchanges x ON x.workspace_id=owner_id AND x.id::text=span.value->>'exchange_id'
  JOIN assistant.messages evidence ON evidence.workspace_id=owner_id AND (evidence.id::text=span.value->>'message_id' OR evidence.id=x.user_message_id)
  JOIN assistant.messages changed ON changed.workspace_id=owner_id AND changed.id=source_id
  WHERE evidence.id=source_id OR (TG_TABLE_NAME IN ('memory_retention_decisions','semantic_source_retention') AND evidence.conversation_id=changed.conversation_id AND evidence.task_id IS NOT DISTINCT FROM changed.task_id)
 ) OR EXISTS(
  SELECT 1 FROM assistant.semantic_exchanges x
  JOIN assistant.messages evidence ON evidence.workspace_id=owner_id AND evidence.id=x.user_message_id
  JOIN assistant.messages changed ON changed.workspace_id=owner_id AND changed.id=source_id
  WHERE x.workspace_id=owner_id AND x.id IN (e.continuation_exchange_id,e.return_region_ref)
  AND (evidence.id=source_id OR (TG_TABLE_NAME IN ('memory_retention_decisions','semantic_source_retention') AND evidence.conversation_id=changed.conversation_id AND evidence.task_id IS NOT DISTINCT FROM changed.task_id))
 ));
 RETURN NULL;
END $$;
CREATE TRIGGER structure_w1b_edited AFTER UPDATE OF content,synthetic ON messages FOR EACH ROW WHEN(OLD.content IS DISTINCT FROM NEW.content OR OLD.synthetic IS DISTINCT FROM NEW.synthetic) EXECUTE FUNCTION invalidate_structure_w1b();
CREATE TRIGGER structure_w1b_suppressed AFTER INSERT OR DELETE ON memory_suppressions FOR EACH ROW EXECUTE FUNCTION invalidate_structure_w1b();
CREATE TRIGGER structure_w1b_retention AFTER INSERT OR UPDATE OR DELETE ON memory_retention_decisions FOR EACH ROW EXECUTE FUNCTION invalidate_structure_w1b();
CREATE TRIGGER structure_w1b_legacy_retention AFTER INSERT OR UPDATE OR DELETE ON semantic_source_retention FOR EACH ROW EXECUTE FUNCTION invalidate_structure_w1b();
