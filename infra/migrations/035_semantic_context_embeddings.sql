CREATE TABLE semantic_context_embeddings (
 workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, context_id uuid NOT NULL,
 model text NOT NULL, input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 vector jsonb NOT NULL CHECK(jsonb_typeof(vector)='array'), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,context_id,model,input_hash),
 FOREIGN KEY(workspace_id,conversation_id,context_id) REFERENCES semantic_contexts(workspace_id,conversation_id,id)
);
