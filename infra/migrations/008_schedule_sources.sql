ALTER TABLE schedules ADD COLUMN source_message_id uuid;
ALTER TABLE schedules ADD COLUMN source_quote text;
ALTER TABLE schedules ADD CONSTRAINT schedule_source_pair CHECK ((source_message_id IS NULL) = (source_quote IS NULL));
ALTER TABLE schedules ADD CONSTRAINT schedule_source_scope FOREIGN KEY(workspace_id,conversation_id,source_message_id) REFERENCES messages(workspace_id,conversation_id,id);
