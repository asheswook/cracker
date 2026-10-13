CREATE TABLE semantic_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL,
 exchange_id uuid NOT NULL, context_id uuid, origin_message_id uuid NOT NULL, origin_source_sha256 text NOT NULL,
 origin_sequence bigint NOT NULL, text text NOT NULL CHECK(length(text)>0), subjects jsonb NOT NULL CHECK(jsonb_typeof(subjects)='array' AND jsonb_array_length(subjects)>0),
 kind text NOT NULL CHECK(kind IN ('fact','recommendation','classification','plan','decision','number')),
 basis text NOT NULL CHECK(basis IN ('sourced','inferred','reported')), epistemic text NOT NULL DEFAULT 'assistant_report' CHECK(epistemic='assistant_report'),
 current_status text NOT NULL DEFAULT 'active' CHECK(current_status IN ('active','challenged','corrected','retracted','reaffirmed')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1), recorded_at timestamptz NOT NULL DEFAULT now(), valid_from timestamptz, valid_to timestamptz,
 extractor_version text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0), provider_model text NOT NULL, prompt_sha256 text NOT NULL CHECK(prompt_sha256~'^[a-f0-9]{64}$'),
 schema_version text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,origin_message_id,origin_source_sha256,extractor_version,ordinal),
 CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from<valid_to),
 FOREIGN KEY(workspace_id,conversation_id,exchange_id) REFERENCES semantic_exchanges(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,origin_message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,origin_message_id,origin_source_sha256) REFERENCES semantic_context_sources(workspace_id,message_id,sha256) ON DELETE CASCADE
);
CREATE INDEX semantic_claim_current ON semantic_claims(workspace_id,conversation_id,exchange_id,origin_sequence DESC) WHERE current_status NOT IN ('corrected','retracted');
CREATE INDEX semantic_claim_tombstone ON semantic_claims(workspace_id,origin_sequence DESC) WHERE current_status IN ('corrected','retracted');
CREATE INDEX semantic_claim_text ON semantic_claims USING gin(to_tsvector('simple',text));
CREATE TABLE semantic_claim_revisions (
 workspace_id uuid NOT NULL, claim_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>=1), previous_revision bigint,
 from_status text CHECK(from_status IN ('active','challenged','corrected','retracted','reaffirmed')),
 to_status text NOT NULL CHECK(to_status IN ('active','challenged','corrected','retracted','reaffirmed')),
 action text NOT NULL CHECK(action IN ('create','challenge','correct','retract','reaffirm','misreading')),
 trigger_message_id uuid NOT NULL, trigger_sequence bigint NOT NULL, actor_role text NOT NULL CHECK(actor_role IN ('user','assistant')),
 recorded_at timestamptz NOT NULL DEFAULT now(), request_sha256 text NOT NULL, model_version text NOT NULL, reason text NOT NULL, interpretation text,
 PRIMARY KEY(workspace_id,claim_id,revision),
 CHECK((revision=1 AND previous_revision IS NULL AND from_status IS NULL AND action='create' AND to_status='active') OR (revision>1 AND previous_revision=revision-1 AND from_status IS NOT NULL AND action<>'create')),
 FOREIGN KEY(workspace_id,claim_id) REFERENCES semantic_claims(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,trigger_message_id) REFERENCES messages(workspace_id,id)
);
CREATE INDEX semantic_claim_trigger ON semantic_claim_revisions(workspace_id,trigger_sequence,request_sha256);
CREATE TABLE semantic_claim_evidence (
 workspace_id uuid NOT NULL, claim_id uuid NOT NULL, claim_revision bigint NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0),
 purpose text NOT NULL CHECK(purpose IN ('origin','basis','effective_time','transition_target','transition_trigger')),
 message_id uuid NOT NULL, source_sha256 text NOT NULL, start_utf16 integer NOT NULL CHECK(start_utf16>=0), end_utf16 integer NOT NULL,
 quote text NOT NULL, requested_quote text, resolution text CHECK(resolution IN ('normalized')), tool_receipt_id uuid, document_snapshot_id uuid,
 verification_status text NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','receipt_verified','independently_verified')),
 PRIMARY KEY(workspace_id,claim_id,claim_revision,ordinal), CHECK(end_utf16>start_utf16),
 FOREIGN KEY(workspace_id,claim_id,claim_revision) REFERENCES semantic_claim_revisions(workspace_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,message_id,source_sha256) REFERENCES semantic_context_sources(workspace_id,message_id,sha256) ON DELETE CASCADE
);
CREATE INDEX semantic_claim_origin_span ON semantic_claim_evidence(workspace_id,message_id,source_sha256,start_utf16,end_utf16) WHERE purpose='origin';
CREATE TABLE semantic_claim_supersessions (
 workspace_id uuid NOT NULL, old_claim_id uuid NOT NULL, new_claim_id uuid NOT NULL, revision_id bigint NOT NULL,
 PRIMARY KEY(workspace_id,old_claim_id,new_claim_id), CHECK(old_claim_id<>new_claim_id),
 FOREIGN KEY(workspace_id,old_claim_id,revision_id) REFERENCES semantic_claim_revisions(workspace_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,new_claim_id) REFERENCES semantic_claims(workspace_id,id) ON DELETE CASCADE
);
CREATE FUNCTION validate_claim_supersession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assistant.semantic_claims prior_claim JOIN assistant.semantic_claims fresh ON fresh.workspace_id=prior_claim.workspace_id WHERE prior_claim.workspace_id=NEW.workspace_id AND prior_claim.id=NEW.old_claim_id AND fresh.id=NEW.new_claim_id AND prior_claim.origin_sequence<fresh.origin_sequence AND prior_claim.current_status IN ('corrected','retracted')) THEN
  RAISE EXCEPTION 'Replacement requires a strictly prior retired claim' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_claim_replacement BEFORE INSERT OR UPDATE ON semantic_claim_supersessions FOR EACH ROW EXECUTE FUNCTION validate_claim_supersession();
CREATE FUNCTION immutable_claim_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Claim history is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER semantic_claim_revision_immutable BEFORE UPDATE ON semantic_claim_revisions FOR EACH ROW EXECUTE FUNCTION immutable_claim_history();
CREATE TRIGGER semantic_claim_evidence_immutable BEFORE UPDATE ON semantic_claim_evidence FOR EACH ROW EXECUTE FUNCTION immutable_claim_history();
CREATE FUNCTION claim_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.current_status IN ('corrected','retracted') AND (NEW.current_status<>OLD.current_status OR NEW.revision<>OLD.revision) THEN
  RAISE EXCEPTION 'Terminal claims cannot revert' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_claim_terminal BEFORE UPDATE ON semantic_claims FOR EACH ROW EXECUTE FUNCTION claim_terminal_guard();
CREATE FUNCTION validate_claim_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assistant.messages m JOIN assistant.semantic_exchange_members member ON member.workspace_id=m.workspace_id AND member.message_id=m.id WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.origin_message_id AND m.conversation_id=NEW.conversation_id AND m.role='assistant' AND NOT m.synthetic AND m.sequence=NEW.origin_sequence AND member.kind='answer' AND member.exchange_id=NEW.exchange_id) THEN
  RAISE EXCEPTION 'Claim origin requires a substantive attributed assistant source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_claim_origin BEFORE INSERT ON semantic_claims FOR EACH ROW EXECUTE FUNCTION validate_claim_origin();
CREATE FUNCTION validate_claim_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assistant.messages m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.trigger_message_id AND m.sequence=NEW.trigger_sequence AND m.role=NEW.actor_role AND NOT m.synthetic) THEN
  RAISE EXCEPTION 'Revision trigger must match its source' USING ERRCODE='23514';
 END IF;
 IF NEW.revision>1 AND NOT EXISTS(SELECT 1 FROM assistant.semantic_claim_revisions r WHERE r.workspace_id=NEW.workspace_id AND r.claim_id=NEW.claim_id AND r.revision=NEW.previous_revision AND r.to_status=NEW.from_status AND r.trigger_sequence<NEW.trigger_sequence AND r.to_status NOT IN ('corrected','retracted')) THEN
  RAISE EXCEPTION 'Revision must follow nonterminal history in source order' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER semantic_claim_revision_source BEFORE INSERT ON semantic_claim_revisions FOR EACH ROW EXECUTE FUNCTION validate_claim_revision();
CREATE TABLE semantic_claim_operations (
 workspace_id uuid NOT NULL, message_id uuid NOT NULL, source_sha256 text NOT NULL, extractor_version text NOT NULL,
 request_hash text NOT NULL, vm_id uuid NOT NULL, result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,message_id,source_sha256,extractor_version),
 FOREIGN KEY(workspace_id,message_id,source_sha256) REFERENCES semantic_context_sources(workspace_id,message_id,sha256) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,vm_id) REFERENCES vms(workspace_id,id)
);
