ALTER TABLE messages ADD COLUMN response_to_message_id uuid;
ALTER TABLE messages ADD COLUMN applied_user_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
-- Phase-null providers can still identify refusals and published artifacts without guessing.
ALTER TABLE messages ADD COLUMN output_kind text;
ALTER TABLE messages ADD CONSTRAINT messages_response_assistant CHECK(response_to_message_id IS NULL OR role='assistant');
ALTER TABLE messages ADD CONSTRAINT messages_provenance_assistant CHECK(cardinality(applied_user_ids)=0 OR role='assistant');
ALTER TABLE messages ADD CONSTRAINT messages_output_kind CHECK(output_kind IS NULL OR (role='assistant' AND output_kind IN ('answer','refusal','artifact','progress')));
ALTER TABLE messages ADD CONSTRAINT messages_response_scope FOREIGN KEY(workspace_id,conversation_id,response_to_message_id) REFERENCES messages(workspace_id,conversation_id,id);
CREATE INDEX messages_response_to ON messages(workspace_id,response_to_message_id) WHERE response_to_message_id IS NOT NULL;

CREATE TABLE semantic_exchanges (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
 user_message_id uuid NOT NULL, sequence bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,user_message_id), UNIQUE(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,user_message_id) REFERENCES messages(workspace_id,conversation_id,id)
);
CREATE FUNCTION validate_semantic_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assistant.messages m WHERE m.workspace_id=NEW.workspace_id AND m.conversation_id=NEW.conversation_id AND m.id=NEW.user_message_id AND m.role='user' AND NOT m.synthetic AND m.sequence=NEW.sequence) THEN
  RAISE EXCEPTION 'Exchange requires a real user message and its sequence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_exchange_source BEFORE INSERT OR UPDATE ON semantic_exchanges FOR EACH ROW EXECUTE FUNCTION validate_semantic_exchange();
CREATE INDEX semantic_exchange_recent ON semantic_exchanges(workspace_id,conversation_id,sequence DESC);
CREATE TABLE semantic_exchange_members (
 workspace_id uuid NOT NULL, message_id uuid NOT NULL, conversation_id uuid NOT NULL, exchange_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('answer','progress','unknown')), method text NOT NULL CHECK(method IN ('response_to','heuristic','legacy')),
 method_version text NOT NULL, run_id uuid, applied_user_ids uuid[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,message_id),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,exchange_id) REFERENCES semantic_exchanges(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id)
);
CREATE INDEX semantic_member_exchange ON semantic_exchange_members(workspace_id,exchange_id);
CREATE TABLE semantic_structure_operations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), operation_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('edge','undo')),
 actor_role text NOT NULL CHECK(actor_role IN ('client','vm')), actor_vm_id uuid,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), request jsonb NOT NULL, result jsonb NOT NULL,
 undo_of uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_id),
 FOREIGN KEY(workspace_id,actor_vm_id) REFERENCES vms(workspace_id,id),
 FOREIGN KEY(workspace_id,undo_of) REFERENCES semantic_structure_operations(workspace_id,operation_id),
 CHECK((actor_role='vm')=(actor_vm_id IS NOT NULL))
);
-- One primary slot, multiple target-keyed reference slots. Partial unique indexes enforce
-- (workspace,child,role) for primary and (workspace,child,target,role) for references.
CREATE TABLE semantic_exchange_edges (
 workspace_id uuid NOT NULL, child_exchange_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('primary','reference')),
 slot text GENERATED ALWAYS AS (CASE WHEN role='primary' THEN 'primary' ELSE target_exchange_id::text END) STORED,
 target_exchange_id uuid, state text NOT NULL CHECK(state IN ('root','unresolved','linked')),
 relation text CHECK(relation IN ('follow_up','challenge','apply_example','correction','new_topic')), is_return boolean NOT NULL DEFAULT false,
 target_message_id uuid, target_source_sha256 text CHECK(target_source_sha256~'^[a-f0-9]{64}$'), target_start integer, target_end integer,
 anchor_confidence numeric CHECK(anchor_confidence BETWEEN 0 AND 1), relation_confidence numeric CHECK(relation_confidence BETWEEN 0 AND 1),
 status text NOT NULL CHECK(status IN ('provisional','confirmed','rejected')), method text NOT NULL CHECK(method IN ('explicit','heuristic','llm','user')),
 model text, policy_version text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 needs_revalidation boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,child_exchange_id,slot),
 FOREIGN KEY(workspace_id,child_exchange_id) REFERENCES semantic_exchanges(workspace_id,id),
 FOREIGN KEY(workspace_id,target_exchange_id) REFERENCES semantic_exchanges(workspace_id,id),
 FOREIGN KEY(workspace_id,target_message_id) REFERENCES messages(workspace_id,id),
 CHECK(child_exchange_id IS DISTINCT FROM target_exchange_id),
 CHECK(role='primary' OR (state='linked' AND target_exchange_id IS NOT NULL)),
 CHECK((state='linked' AND target_exchange_id IS NOT NULL AND relation IS NOT NULL AND target_message_id IS NOT NULL AND target_source_sha256 IS NOT NULL AND target_start IS NOT NULL AND target_end IS NOT NULL AND target_start>=0 AND target_end>target_start) OR
       (state<>'linked' AND target_exchange_id IS NULL AND relation IS NULL AND target_message_id IS NULL AND target_source_sha256 IS NULL AND target_start IS NULL AND target_end IS NULL AND NOT is_return))
);
CREATE UNIQUE INDEX semantic_edge_primary ON semantic_exchange_edges(workspace_id,child_exchange_id,role) WHERE role='primary';
CREATE UNIQUE INDEX semantic_edge_reference ON semantic_exchange_edges(workspace_id,child_exchange_id,target_exchange_id,role) WHERE role='reference';
CREATE INDEX semantic_edge_reverse ON semantic_exchange_edges(workspace_id,target_exchange_id);
CREATE TABLE semantic_exchange_edge_revisions (
 workspace_id uuid NOT NULL, child_exchange_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('primary','reference')), slot text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), operation_id uuid NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,child_exchange_id,slot,revision),
 FOREIGN KEY(workspace_id,child_exchange_id) REFERENCES semantic_exchanges(workspace_id,id),
 FOREIGN KEY(workspace_id,operation_id) REFERENCES semantic_structure_operations(workspace_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX semantic_edge_history ON semantic_exchange_edge_revisions(workspace_id,child_exchange_id,role,revision);
CREATE FUNCTION immutable_semantic_edge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Semantic edge revisions are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER semantic_edge_revision_immutable BEFORE UPDATE OR DELETE ON semantic_exchange_edge_revisions FOR EACH ROW EXECUTE FUNCTION immutable_semantic_edge_revision();
CREATE FUNCTION validate_semantic_edge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='linked' AND NOT EXISTS (
  SELECT 1 FROM assistant.semantic_exchanges child JOIN assistant.semantic_exchanges target ON target.workspace_id=child.workspace_id
  JOIN assistant.messages m ON m.workspace_id=target.workspace_id AND m.conversation_id=target.conversation_id
  WHERE child.workspace_id=NEW.workspace_id AND child.id=NEW.child_exchange_id AND target.id=NEW.target_exchange_id
   AND target.sequence<child.sequence AND m.id=NEW.target_message_id AND m.sequence<child.sequence
   AND (m.id=target.user_message_id OR EXISTS(SELECT 1 FROM assistant.semantic_exchange_members member WHERE member.workspace_id=NEW.workspace_id AND member.exchange_id=target.id AND member.message_id=m.id))
 ) THEN RAISE EXCEPTION 'Edge target must belong to an earlier exchange' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_edge_target BEFORE INSERT OR UPDATE OF target_exchange_id,target_message_id,state ON semantic_exchange_edges FOR EACH ROW EXECUTE FUNCTION validate_semantic_edge();
-- Invalidation is derived dirtiness, not a new semantic decision/revision. Readers exclude
-- dirty heads; successful CAS revalidation creates a revision and clears the bit.
CREATE FUNCTION invalidate_semantic_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='messages' THEN source_id:=NEW.id; owner_id:=NEW.workspace_id;
 ELSIF TG_OP='DELETE' THEN source_id:=OLD.source_message_id; owner_id:=OLD.workspace_id;
 ELSE source_id:=NEW.source_message_id; owner_id:=NEW.workspace_id; END IF;
 -- Serialize invalidation with validation+commit, including cross-conversation targets.
 -- Source edits remain invisible until this transaction has dirtied all matching heads.
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text||':semantic-structure',0));
 UPDATE assistant.semantic_exchange_edges e SET needs_revalidation=true
 WHERE e.workspace_id=owner_id AND (e.target_message_id=source_id OR EXISTS(
  SELECT 1 FROM assistant.semantic_exchanges x WHERE x.workspace_id=owner_id AND x.id IN (e.child_exchange_id,e.target_exchange_id) AND x.user_message_id=source_id
 ) OR (TG_TABLE_NAME IN ('memory_retention_decisions','semantic_source_retention') AND EXISTS(
  SELECT 1 FROM assistant.messages changed JOIN assistant.messages affected ON affected.workspace_id=changed.workspace_id AND affected.conversation_id=changed.conversation_id AND affected.task_id IS NOT DISTINCT FROM changed.task_id
  WHERE changed.workspace_id=owner_id AND changed.id=source_id AND (affected.id=e.target_message_id OR EXISTS(SELECT 1 FROM assistant.semantic_exchanges x WHERE x.workspace_id=owner_id AND x.id=e.child_exchange_id AND x.user_message_id=affected.id))
 )));
 RETURN NULL;
END $$;
CREATE TRIGGER structure_source_edited AFTER UPDATE OF content,synthetic ON messages FOR EACH ROW WHEN(OLD.content IS DISTINCT FROM NEW.content OR OLD.synthetic IS DISTINCT FROM NEW.synthetic) EXECUTE FUNCTION invalidate_semantic_structure();
CREATE TRIGGER structure_source_suppressed AFTER INSERT OR DELETE ON memory_suppressions FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_structure();
CREATE TRIGGER structure_retention_changed AFTER INSERT OR UPDATE OR DELETE ON memory_retention_decisions FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_structure();
CREATE TRIGGER structure_legacy_retention_changed AFTER INSERT OR UPDATE OR DELETE ON semantic_source_retention FOR EACH ROW EXECUTE FUNCTION invalidate_semantic_structure();
