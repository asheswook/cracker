ALTER TABLE events ADD CONSTRAINT events_workspace_identity UNIQUE(workspace_id,id);
ALTER TABLE outbox DROP CONSTRAINT outbox_event_id_fkey;
ALTER TABLE outbox ADD CONSTRAINT outbox_workspace_event FOREIGN KEY(workspace_id,event_id) REFERENCES events(workspace_id,id);
