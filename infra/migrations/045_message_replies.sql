ALTER TABLE messages ADD COLUMN reply_to_message_id uuid;
ALTER TABLE messages ADD CONSTRAINT message_reply_workspace FOREIGN KEY(workspace_id,reply_to_message_id) REFERENCES messages(workspace_id,id);
ALTER TABLE messages ADD CONSTRAINT message_reply_not_self CHECK(reply_to_message_id IS NULL OR reply_to_message_id<>id);
CREATE INDEX message_reply_target ON messages(workspace_id,reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
DROP INDEX task_active;
CREATE UNIQUE INDEX task_active ON tasks(conversation_id) WHERE state NOT IN ('cancelled','succeeded','failed','unknown');
