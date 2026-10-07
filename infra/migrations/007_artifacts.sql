CREATE TABLE artifacts(
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces,
 conversation_id uuid NOT NULL,
 name text NOT NULL,
 media_type text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>=0 AND bytes<=10485760),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 object_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','failed','deleted')),
 lease_id uuid NOT NULL,
 lease_expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 purged_at timestamptz,
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id)
);
CREATE INDEX artifacts_quota ON artifacts(workspace_id) WHERE purged_at IS NULL;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_identity UNIQUE(workspace_id,conversation_id,id);
CREATE TABLE message_artifacts(
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 message_id uuid NOT NULL,
 artifact_id uuid NOT NULL,
 position integer NOT NULL CHECK(position>=0 AND position<8),
 PRIMARY KEY(message_id,artifact_id),
 UNIQUE(message_id,position),
 FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id),
 FOREIGN KEY(workspace_id,conversation_id,artifact_id) REFERENCES artifacts(workspace_id,conversation_id,id)
);
