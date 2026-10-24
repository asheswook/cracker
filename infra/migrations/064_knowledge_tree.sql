-- Workspace-wide hierarchical knowledge tree.
-- Nodes carry the summaries; the exchanges themselves stay in messages and are referenced by membership rows.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_nodes (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 parent_id uuid, kind text NOT NULL CHECK(kind IN ('topic','rule','event')),
 title text NOT NULL CHECK(length(btrim(title))>0),
 aliases jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(aliases)='array'),
 -- [{text, evidence:[{user_message_id,message_id,quote}]}]; at most 24 facts per node.
 summary jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(summary)='array' AND jsonb_array_length(summary)<=24),
 entities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(entities)='array'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','merged')),
 merged_into uuid, depth integer NOT NULL DEFAULT 0 CHECK(depth>=0), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 -- bge-m3 (1024) of title+aliases+summary; embedded_sha256 is the hash of the text that was embedded.
 embedding vector(1024), embedded_sha256 text CHECK(embedded_sha256 IS NULL OR embedded_sha256~'^[a-f0-9]{64}$'),
 created_sequence bigint NOT NULL, updated_sequence bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,parent_id) REFERENCES knowledge_nodes(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,merged_into) REFERENCES knowledge_nodes(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(parent_id IS DISTINCT FROM id), CHECK(merged_into IS DISTINCT FROM id),
 CHECK((status='merged')=(merged_into IS NOT NULL)),
 CHECK((embedding IS NULL)=(embedded_sha256 IS NULL))
);
CREATE INDEX knowledge_node_parent ON knowledge_nodes(workspace_id,parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX knowledge_node_live ON knowledge_nodes(workspace_id,status);
CREATE INDEX knowledge_node_embedding_cosine ON knowledge_nodes USING hnsw(embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE knowledge_node_members (
 workspace_id uuid NOT NULL, node_id uuid NOT NULL, user_message_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','mention')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,node_id,user_message_id),
 FOREIGN KEY(workspace_id,node_id) REFERENCES knowledge_nodes(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,user_message_id) REFERENCES messages(workspace_id,id)
);
-- Every processed exchange has exactly one owner node; mentions are unlimited.
CREATE UNIQUE INDEX knowledge_member_owner ON knowledge_node_members(workspace_id,user_message_id) WHERE role='owner';
CREATE INDEX knowledge_member_message ON knowledge_node_members(workspace_id,user_message_id);
CREATE FUNCTION validate_knowledge_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM assistant.messages m WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.user_message_id AND m.role='user' AND NOT m.synthetic) THEN
  RAISE EXCEPTION 'Knowledge membership requires a real user message' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_member_source BEFORE INSERT OR UPDATE OF user_message_id ON knowledge_node_members FOR EACH ROW EXECUTE FUNCTION validate_knowledge_member();

-- Greetings / acknowledgements: owned like any exchange but never searchable on their own.
CREATE TABLE knowledge_noise (
 workspace_id uuid NOT NULL, user_message_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,user_message_id),
 FOREIGN KEY(workspace_id,user_message_id) REFERENCES messages(workspace_id,id)
);

CREATE TABLE knowledge_links (
 workspace_id uuid NOT NULL, from_node uuid NOT NULL, to_node uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('branch','part_of','reference','governs')),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)>0),
 confidence numeric NOT NULL CHECK(confidence BETWEEN 0 AND 1), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,from_node,to_node,kind),
 FOREIGN KEY(workspace_id,from_node) REFERENCES knowledge_nodes(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,to_node) REFERENCES knowledge_nodes(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(from_node<>to_node)
);
CREATE INDEX knowledge_link_reverse ON knowledge_links(workspace_id,to_node);

-- People / organizations / dates named in an exchange; drives merge and cross-link candidates.
CREATE TABLE knowledge_entities (
 workspace_id uuid NOT NULL, user_message_id uuid NOT NULL, entities jsonb NOT NULL CHECK(jsonb_typeof(entities)='array'),
 PRIMARY KEY(workspace_id,user_message_id),
 FOREIGN KEY(workspace_id,user_message_id) REFERENCES messages(workspace_id,id)
);

-- Append-only operation log (before/after images of the touched rows) for history and undo.
CREATE TABLE knowledge_ops (
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), user_message_id uuid,
 op text NOT NULL, before jsonb NOT NULL, after jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,user_message_id) REFERENCES messages(workspace_id,id)
);
CREATE INDEX knowledge_ops_workspace ON knowledge_ops(workspace_id,id);
CREATE FUNCTION immutable_knowledge_op() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Knowledge operations are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER knowledge_op_immutable BEFORE UPDATE OR DELETE ON knowledge_ops FOR EACH ROW EXECUTE FUNCTION immutable_knowledge_op();

-- Background update queue: per workspace strictly in message order, exponential retry, parked after repeated failure.
CREATE TABLE knowledge_tree_queue (
 id bigserial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), user_message_id uuid NOT NULL,
 conversation_id uuid NOT NULL, sequence bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','done','parked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), retry_at timestamptz NOT NULL DEFAULT now(),
 claimed_until timestamptz, claim_id uuid, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,user_message_id),
 FOREIGN KEY(workspace_id,conversation_id,user_message_id) REFERENCES messages(workspace_id,conversation_id,id),
 CHECK((state='claimed')=(claimed_until IS NOT NULL))
);
CREATE INDEX knowledge_queue_open ON knowledge_tree_queue(workspace_id,sequence) WHERE state IN ('pending','claimed');
CREATE INDEX knowledge_queue_parked ON knowledge_tree_queue(workspace_id) WHERE state='parked';
