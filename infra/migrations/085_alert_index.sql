-- Recent alerts of a workspace are re-checked on every tick.
CREATE INDEX attention_due_alerts_recent ON attention_due_alerts(workspace_id, created_at);
